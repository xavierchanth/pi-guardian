import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { RepositoryEnrollmentReceiptV1, RepositoryMutationLeaseV1, SessionWorkspaceCustodyV1, SessionWorkspaceIdentityV1 } from "../concurrency/productization.ts";
import { absolutePath } from "./domain.ts";
import { JjProcessExecutor, renderJjExecutionFailure, type JjAccess, type JjExecutor } from "./executor.ts";

const CHANGE_ID_TEMPLATE = 'change_id ++ "\\n"';
const WORKSPACE_TEMPLATE = 'name ++ "|" ++ target.change_id() ++ "\\n"';

export interface SessionWorkspaceStore {
  get(workspaceId: string): Promise<SessionWorkspaceCustodyV1 | undefined>;
  put(workspaceId: string, custody: SessionWorkspaceCustodyV1): Promise<void>;
  list(): Promise<SessionWorkspaceCustodyV1[]>;
}

export interface WorkspaceHostServicePort { request<T = unknown>(method: string, params: unknown): Promise<T>; }

export class HostSessionWorkspaceStore implements SessionWorkspaceStore {
  private readonly host: WorkspaceHostServicePort;
  private readonly rootSessionId: string;
  private readonly revisions = new Map<string, number>();
  constructor(host: WorkspaceHostServicePort, rootSessionId: string) { this.host = host; this.rootSessionId = rootSessionId; }
  async get(workspaceId: string): Promise<SessionWorkspaceCustodyV1 | undefined> {
    const aggregate = await this.host.request<any>("session.workspace.load", { workspaceId });
    if (!aggregate) { this.revisions.set(workspaceId, 0); return undefined; }
    if (!Number.isSafeInteger(aggregate.revision) || aggregate.revision < 1 || !aggregate.projection) throw new Error("Host session workspace aggregate is invalid.");
    this.revisions.set(workspaceId, aggregate.revision);
    return aggregate.projection as SessionWorkspaceCustodyV1;
  }
  async put(workspaceId: string, custody: SessionWorkspaceCustodyV1): Promise<void> {
    if (("rootSessionId" in custody ? custody.rootSessionId : custody.identity.rootSessionId) !== this.rootSessionId) throw new Error("Session workspace custody belongs to another Host session.");
    const expectedRevision = this.revisions.get(workspaceId) ?? (await this.get(workspaceId), this.revisions.get(workspaceId) ?? 0);
    const aggregate = await this.host.request<any>("session.workspace.put", { workspaceId, transactionId: `session-workspace-transaction-${randomUUID()}`, expectedRevision, value: custody });
    if (!Number.isSafeInteger(aggregate?.revision) || aggregate.revision !== expectedRevision + 1) throw new Error("Host did not durably advance session workspace custody.");
    this.revisions.set(workspaceId, aggregate.revision);
  }
  async list(): Promise<SessionWorkspaceCustodyV1[]> { throw new Error("Host session workspace listing uses bounded concurrency projections."); }
}

export class FileSessionWorkspaceStore implements SessionWorkspaceStore {
  readonly root: string;
  constructor(root: string) { this.root = root; }
  async get(workspaceId: string): Promise<SessionWorkspaceCustodyV1 | undefined> {
    try { return JSON.parse(await readFile(this.path(workspaceId), "utf8")) as SessionWorkspaceCustodyV1; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async put(workspaceId: string, custody: SessionWorkspaceCustodyV1): Promise<void> {
    validateId(workspaceId); await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = this.path(workspaceId); const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(custody, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  }
  async list(): Promise<SessionWorkspaceCustodyV1[]> {
    const { readdir } = await import("node:fs/promises");
    try { const output: SessionWorkspaceCustodyV1[] = []; for (const name of (await readdir(this.root)).filter((item) => item.endsWith(".json")).sort()) { const value = await this.get(name.slice(0, -5)); if (value) output.push(value); } return output; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  private path(workspaceId: string): string { validateId(workspaceId); return join(this.root, `${workspaceId}.json`); }
}

export interface RepositoryLeaseStore {
  get(repositoryId: string): Promise<RepositoryMutationLeaseV1 | undefined>;
  put(repositoryId: string, lease: RepositoryMutationLeaseV1): Promise<void>;
}

export class InMemoryRepositoryLeaseStore implements RepositoryLeaseStore {
  private readonly states = new Map<string, RepositoryMutationLeaseV1>();
  get(repositoryId: string): Promise<RepositoryMutationLeaseV1 | undefined> { return Promise.resolve(this.states.get(repositoryId)); }
  put(repositoryId: string, lease: RepositoryMutationLeaseV1): Promise<void> { this.states.set(repositoryId, lease); return Promise.resolve(); }
}

export interface RepositoryMutationCoordinatorPort {
  withLease<T>(input: { repositoryId: string; rootSessionId: string; runtimeGeneration: number; operationId: string }, action: (lease: Extract<RepositoryMutationLeaseV1, { phase: "leased" }>) => Promise<T>): Promise<T>;
}

export class RepositoryMutationCoordinator implements RepositoryMutationCoordinatorPort {
  private readonly store: RepositoryLeaseStore;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly now: () => string;
  constructor(store: RepositoryLeaseStore, now: () => string = () => new Date().toISOString()) { this.store = store; this.now = now; }

  async withLease<T>(input: { repositoryId: string; rootSessionId: string; runtimeGeneration: number; operationId: string }, action: (lease: Extract<RepositoryMutationLeaseV1, { phase: "leased" }>) => Promise<T>): Promise<T> {
    const prior = (this.queues.get(input.repositoryId) ?? Promise.resolve()).catch(() => undefined);
    let release!: () => void; const gate = new Promise<void>((done) => { release = done; }); const chain = prior.then(() => gate); this.queues.set(input.repositoryId, chain);
    await prior;
    try {
      const current = await this.store.get(input.repositoryId);
      if (current?.phase === "leased" || current?.phase === "interrupted") throw new Error(`Repository ${input.repositoryId} has unresolved mutation authority in phase ${current.phase}.`);
      const generation = (current?.generation ?? 0) + 1;
      const lease: Extract<RepositoryMutationLeaseV1, { phase: "leased" }> = {
        phase: "leased", repositoryId: input.repositoryId, generation, leaseId: `repo-lease-${randomUUID()}`,
        rootSessionId: input.rootSessionId, runtimeGeneration: input.runtimeGeneration, operationId: input.operationId, acquiredAt: this.now(),
      };
      await this.store.put(input.repositoryId, lease);
      try {
        const output = await action(lease);
        await this.store.put(input.repositoryId, { phase: "available", repositoryId: input.repositoryId, generation });
        return output;
      } catch (error) {
        await this.store.put(input.repositoryId, {
          phase: "interrupted", repositoryId: input.repositoryId, generation, priorLeaseId: lease.leaseId,
          priorRootSessionId: lease.rootSessionId, priorRuntimeGeneration: lease.runtimeGeneration, operationId: lease.operationId,
          reason: error instanceof Error ? error.message : String(error), interruptedAt: this.now(),
        });
        throw error;
      }
    } finally { release(); if (this.queues.get(input.repositoryId) === chain) this.queues.delete(input.repositoryId); }
  }

  async reconcile(repositoryId: string, proof: { mutationDidNotStart: boolean }): Promise<void> {
    const current = await this.store.get(repositoryId);
    if (!current || current.phase !== "interrupted") return;
    if (!proof.mutationDidNotStart) throw new Error("Interrupted repository mutation requires semantic operation reconciliation before lease release.");
    await this.store.put(repositoryId, { phase: "available", repositoryId, generation: current.generation });
  }
}

export interface RepositoryHostServicePort { request<T = unknown>(method: string, params: unknown): Promise<T>; }

export class HostRepositoryMutationCoordinator implements RepositoryMutationCoordinatorPort {
  private readonly host: RepositoryHostServicePort;
  constructor(host: RepositoryHostServicePort) { this.host = host; }
  async withLease<T>(input: { repositoryId: string; rootSessionId: string; runtimeGeneration: number; operationId: string }, action: (lease: Extract<RepositoryMutationLeaseV1, { phase: "leased" }>) => Promise<T>): Promise<T> {
    const transactionId = `repository-lease-acquire-${randomUUID()}`;
    const deadline = Date.now() + 30_000;
    let lease: Extract<RepositoryMutationLeaseV1, { phase: "leased" }>;
    while (true) {
      try { lease = await this.host.request<Extract<RepositoryMutationLeaseV1, { phase: "leased" }>>("repository.lease.acquire", { ...input, transactionId }); break; }
      catch (error) {
        if (!/repository is busy/i.test(error instanceof Error ? error.message : String(error)) || Date.now() >= deadline) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
    }
    if (lease.phase !== "leased" || lease.repositoryId !== input.repositoryId || lease.operationId !== input.operationId) throw new Error("Host returned invalid repository mutation authority.");
    try {
      const output = await action(lease);
      await this.host.request("repository.lease.release", { repositoryId: input.repositoryId, leaseId: lease.leaseId, operationId: input.operationId, transactionId: `repository-lease-release-${randomUUID()}` });
      return output;
    } catch (error) {
      await this.host.request("repository.lease.interrupt", { repositoryId: input.repositoryId, leaseId: lease.leaseId, operationId: input.operationId, reason: error instanceof Error ? error.message : String(error), transactionId: `repository-lease-interrupt-${randomUUID()}` }).catch(() => undefined);
      throw error;
    }
  }
}

export class SessionWorkspaceService {
  private readonly store: SessionWorkspaceStore;
  private readonly coordinator: RepositoryMutationCoordinatorPort;
  private readonly executor: JjExecutor;
  private readonly now: () => string;
  private readonly failpoint?: (boundary: string) => void;
  constructor(options: { store: SessionWorkspaceStore; coordinator: RepositoryMutationCoordinatorPort; executor?: JjExecutor; now?: () => string; failpoint?: (boundary: string) => void }) {
    this.store = options.store; this.coordinator = options.coordinator; this.executor = options.executor ?? new JjProcessExecutor(); this.now = options.now ?? (() => new Date().toISOString()); this.failpoint = options.failpoint;
  }

  async allocate(input: { enrollment: RepositoryEnrollmentReceiptV1; invokingCwd: string; rootSessionId: string; runtimeGeneration: number }): Promise<SessionWorkspaceIdentityV1> {
    validateId(input.rootSessionId);
    const workspaceId = `session-workspace-${input.rootSessionId}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 128);
    const workspaceName = `pi-tai-${shortId(input.rootSessionId)}`;
    const path = join(input.enrollment.managedWorkspaceRoot, "sessions", shortId(input.rootSessionId));
    requireInside(input.enrollment.managedWorkspaceRoot, path);
    const existing = await this.store.get(workspaceId);
    if (existing?.phase === "ready") {
      const identity = existing.identity;
      if (identity.repositoryId !== input.enrollment.repositoryId || identity.rootSessionId !== input.rootSessionId || resolve(identity.path) !== resolve(path)) throw new Error("Persisted session workspace custody conflicts with repository or session identity.");
      const orchestrationChangeId = line(await this.run(identity.path, ["log", "--revision", "@", "--no-graph", "--template", CHANGE_ID_TEMPLATE], "read"), "recovered session orchestration Change ID");
      if (orchestrationChangeId !== identity.orchestrationChangeId) throw new Error("Persisted session workspace no longer matches its acknowledged custody identity.");
      await this.store.put(workspaceId, { ...existing, generation: input.runtimeGeneration, verifiedAt: this.now() });
      return identity;
    }
    if (existing) {
      if (existing.phase === "allocating") await this.store.put(workspaceId, { version: 1, phase: "attention_required", repositoryId: input.enrollment.repositoryId, rootSessionId: input.rootSessionId, workspaceId, lastSafeBoundary: "prepared", reason: "Host restarted during session workspace allocation; explicit repair is required before any JJ mutation.", evidence: existing, stoppedAt: this.now() });
      throw new Error(`Session workspace custody is ${existing.phase}; explicit recovery or cleanup is required.`);
    }
    const operationId = `session-allocate-${randomUUID()}`;
    const startedAt = this.now();
    await this.store.put(workspaceId, { version: 1, phase: "allocating", repositoryId: input.enrollment.repositoryId, rootSessionId: input.rootSessionId, workspaceId, operationId, plannedPath: path, startedAt });
    this.failpoint?.("prepared");
    try {
      return await this.coordinator.withLease({ repositoryId: input.enrollment.repositoryId, rootSessionId: input.rootSessionId, runtimeGeneration: input.runtimeGeneration, operationId }, async () => {
        const sourceChangeId = line(await this.run(input.invokingCwd, ["log", "--revision", "@", "--no-graph", "--template", CHANGE_ID_TEMPLATE], "read"), "source @ Change ID");
        const sourceWorkspaceName = currentWorkspace(await this.run(input.invokingCwd, ["workspace", "list", "--template", WORKSPACE_TEMPLATE], "read"), sourceChangeId);
        const baseChangeId = line(await this.run(input.invokingCwd, ["log", "--revision", "@-", "--no-graph", "--template", CHANGE_ID_TEMPLATE], "read"), "source @- Change ID");
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await this.run(input.invokingCwd, ["workspace", "add", path, "--name", workspaceName, "--revision", exactChange(baseChangeId), "--message", `pi-tai: session ${input.rootSessionId}`], "write");
        this.failpoint?.("workspace_added");
        const orchestrationChangeId = line(await this.run(path, ["log", "--revision", "@", "--no-graph", "--template", CHANGE_ID_TEMPLATE], "read"), "session orchestration Change ID");
        const identity: SessionWorkspaceIdentityV1 = {
          repositoryId: input.enrollment.repositoryId, rootSessionId: input.rootSessionId, workspaceId, workspaceName, path,
          sourceWorkspaceName, orchestrationChangeId,
        };
        await this.store.put(workspaceId, { version: 1, phase: "ready", identity, generation: input.runtimeGeneration, verifiedAt: this.now() });
        this.failpoint?.("verified");
        return identity;
      });
    } catch (error) {
      const current = await this.store.get(workspaceId);
      await this.store.put(workspaceId, {
        version: 1, phase: "attention_required", repositoryId: input.enrollment.repositoryId, rootSessionId: input.rootSessionId, workspaceId,
        lastSafeBoundary: current?.phase === "allocating" ? "prepared" : "workspace_added", reason: error instanceof Error ? error.message : String(error), evidence: current, stoppedAt: this.now(),
      });
      throw error;
    }
  }

  async retryCleanup(input: { enrollment: RepositoryEnrollmentReceiptV1; rootSessionId: string; runtimeGeneration: number }): Promise<void> {
    const workspaceId = `session-workspace-${input.rootSessionId}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 128);
    const current = await this.store.get(workspaceId);
    if (!current) throw new Error(`Unknown session workspace: ${workspaceId}`);
    if (current.phase === "retired") return;
    if (current.phase !== "ready" && current.phase !== "cleanup_pending") throw new Error(`Session workspace cleanup cannot start from ${current.phase}.`);
    const identity = current.identity;
    if (identity.repositoryId !== input.enrollment.repositoryId) throw new Error("Session workspace cleanup crossed repository enrollment authority.");
    await this.store.put(workspaceId, { version: 1, phase: "cleanup_pending", identity, reason: "session_closed", requestedAt: this.now() });
    try {
      await this.coordinator.withLease({ repositoryId: identity.repositoryId, rootSessionId: input.rootSessionId, runtimeGeneration: input.runtimeGeneration, operationId: `session-cleanup-${randomUUID()}` }, async () => {
        const patch = await this.run(identity.path, ["diff", "--revision", "@", "--git"], "read");
        if (patch.trim()) throw new Error("Session orchestration change still contains unintegrated work; cleanup refuses to discard it.");
        await this.run(input.enrollment.canonicalRepositoryPath, ["workspace", "forget", identity.workspaceName], "write");
        await rm(identity.path, { recursive: true, force: true });
      });
      await this.store.put(workspaceId, { version: 1, phase: "retired", identity, retiredAt: this.now() });
    } catch (error) {
      await this.store.put(workspaceId, { version: 1, phase: "attention_required", repositoryId: identity.repositoryId, rootSessionId: identity.rootSessionId, workspaceId, identity, lastSafeBoundary: "cleanup_pending", reason: error instanceof Error ? error.message : String(error), evidence: current, stoppedAt: this.now() });
      throw error;
    }
  }

  private async run(cwd: string, args: readonly string[], accessMode: JjAccess): Promise<string> {
    const result = await this.executor.execute({ cwd: absolutePath(resolve(cwd)), args, access: accessMode });
    if (result.kind === "success") return result.stdout;
    throw new Error(`jj argv ${JSON.stringify(args)} failed: ${result.stderr.trim() || renderJjExecutionFailure(result.failure)}`);
  }
}

function currentWorkspace(output: string, currentChangeId: string): string {
  const names = output.split(/\r?\n/).filter(Boolean).map((row) => row.split("|", 2)).filter(([, id]) => id === currentChangeId).map(([name]) => name!);
  if (names.length !== 1) throw new Error("Unable to resolve exactly one invoking JJ workspace."); return names[0]!;
}
function exactChange(value: string): string { if (!/^[a-z]{32}$/.test(value)) throw new Error(`Invalid full JJ Change ID: ${value}`); return `exactly(change_id(${value}), 1)`; }
function line(output: string, label: string): string { const values = output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean); if (values.length !== 1) throw new Error(`Unable to resolve one ${label}.`); return values[0]!; }
function shortId(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 20); }
function requireInside(root: string, path: string): void { const base = resolve(root); const target = resolve(path); if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error("Managed session workspace escaped its enrolled root."); if (relative(base, target).split(sep).includes("..")) throw new Error("Managed session workspace escaped its enrolled root."); }
function validateId(value: string): void { if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)) throw new Error(`Invalid managed ID: ${value}`); }
