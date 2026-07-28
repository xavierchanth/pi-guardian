import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  checkpointableFileSetClaim,
  changeId,
  type CheckpointableFileSetClaim,
  type SourceWorkspaceHandle,
} from "../jj/domain.ts";
import type {
  PersistedFileSetClaimV1,
  PersistedPathFingerprintV1,
  PersistedSharedSourceV1,
  SharedSourceStore,
} from "../jj/persistence.ts";
import { childContextId, fileSetClaimId, rootSessionId } from "./ids.ts";

export interface FileSetBaseline {
  readonly workingChangeId: string;
  readonly patchHash: string;
  readonly changedPaths: readonly string[];
}

export type FileSetBaselineVerifier = (
  source: SourceWorkspaceHandle,
  paths: readonly string[],
) => Promise<FileSetBaseline>;

export interface AcquireFileSetInput {
  readonly rootSessionId: string;
  readonly ownerContextId: string;
  readonly paths: readonly string[];
  readonly signal?: AbortSignal;
}

export interface ActiveFileSetClaim {
  readonly handle: CheckpointableFileSetClaim;
  readonly source: SourceWorkspaceHandle;
  readonly record: Extract<PersistedFileSetClaimV1, { phase: "active" | "checkpointing" }>;
}

interface Waiter {
  readonly claimId: string;
  readonly source: SourceWorkspaceHandle;
  readonly signal?: AbortSignal;
  readonly resolve: (value: CheckpointableFileSetClaim) => void;
  readonly reject: (reason: Error) => void;
  abort?: () => void;
}

export class SharedFileSetCoordinator {
  private readonly store: SharedSourceStore;
  private readonly verifyBaseline: FileSetBaselineVerifier;
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly active = new Map<string, Set<string>>();
  private readonly initialized = new Set<string>();
  private readonly initializing = new Map<string, Promise<void>>();
  private readonly scheduling = new Map<string, Promise<void>>();
  private readonly now: () => string;

  constructor(options: { store: SharedSourceStore; verifyBaseline: FileSetBaselineVerifier; now?: () => string }) {
    this.store = options.store;
    this.verifyBaseline = options.verifyBaseline;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async initialize(source: SourceWorkspaceHandle): Promise<void> {
    if (this.initialized.has(source.sourceId)) return;
    const pending = this.initializing.get(source.sourceId);
    if (pending) return pending;
    const initialization = this.store
      .interruptLiveClaims(source.sourceId, "process restart cleared live file-set authority", this.now())
      .then(() => {
        this.initialized.add(source.sourceId);
        this.active.set(source.sourceId, new Set());
      })
      .finally(() => { this.initializing.delete(source.sourceId); });
    this.initializing.set(source.sourceId, initialization);
    return initialization;
  }

  async acquire(source: SourceWorkspaceHandle, input: AcquireFileSetInput): Promise<CheckpointableFileSetClaim> {
    await this.initialize(source);
    if (input.signal?.aborted) throw abortError();
    const sourceRecord = await this.requireSource(source);
    const target = [...sourceRecord.targets].reverse().find((candidate) => candidate.ownerContextId === input.ownerContextId);
    if (!target) throw new Error(`Context ${input.ownerContextId} has no assigned shared Change ID.`);
    const paths = await canonicalizeFileSet(sourceRecord.workspacePath, input.paths);
    const claimId = `claim-${randomUUID()}`;
    const at = this.now();
    const claim: PersistedFileSetClaimV1 = {
      phase: "queued",
      claimId,
      ownerContextId: childContextId(input.ownerContextId),
      rootSessionId: rootSessionId(input.rootSessionId),
      targetChangeId: target.changeId,
      baseChangeId: target.baseChangeId,
      workingChangeId: target.workingChangeId,
      paths,
      queuedAt: at,
    };
    await this.store.update(source.sourceId, (record) => ({
      ...record,
      claims: [...record.claims, claim],
      updatedAt: at,
    }));
    return new Promise<CheckpointableFileSetClaim>((resolveClaim, rejectClaim) => {
      const waiter: Waiter = {
        claimId,
        source,
        signal: input.signal,
        resolve: resolveClaim,
        reject: rejectClaim,
      };
      if (input.signal) {
        waiter.abort = () => { void this.cancelQueued(waiter, "file-set acquisition cancelled"); };
        input.signal.addEventListener("abort", waiter.abort, { once: true });
      }
      const queue = this.waiters.get(source.sourceId) ?? [];
      queue.push(waiter);
      this.waiters.set(source.sourceId, queue);
      void this.schedule(source);
    });
  }

  async requireActive(handle: CheckpointableFileSetClaim): Promise<ActiveFileSetClaim> {
    for (const source of await this.store.list()) {
      const claim = source.claims.find((candidate) => candidate.claimId === handle.claimId);
      if (!claim) continue;
      if (claim.phase !== "active" && claim.phase !== "checkpointing") {
        throw new Error(`File-set claim ${handle.claimId} is ${claim.phase}, not active.`);
      }
      const sourceHandle = { kind: "source_workspace", sourceId: source.sourceId } as SourceWorkspaceHandle;
      return { handle, source: sourceHandle, record: claim };
    }
    throw new Error(`Unknown file-set claim: ${handle.claimId}`);
  }

  async activeForOwner(source: SourceWorkspaceHandle, ownerContextId: string): Promise<ActiveFileSetClaim | undefined> {
    const record = await this.requireSource(source);
    const claim = record.claims.find((candidate) =>
      candidate.ownerContextId === ownerContextId && (candidate.phase === "active" || candidate.phase === "checkpointing"),
    );
    if (!claim || (claim.phase !== "active" && claim.phase !== "checkpointing")) return undefined;
    return { handle: checkpointableFileSetClaim(fileSetClaimId(claim.claimId)), source, record: claim };
  }

  async authorizeUnclaimedPath(source: SourceWorkspaceHandle, inputPath: string): Promise<string> {
    const sourceRecord = await this.requireSource(source);
    const [path] = await canonicalizeFileSet(sourceRecord.workspacePath, [inputPath]);
    const collision = sourceRecord.claims.find((claim) =>
      (claim.phase === "active" || claim.phase === "checkpointing") && claim.paths.some((root) => pathCovered(root, path) || pathCovered(path, root)),
    );
    if (collision) throw new Error(`Path ${path} overlaps active claim ${collision.claimId} owned by ${collision.ownerContextId}.`);
    return path!;
  }

  async authorizePath(source: SourceWorkspaceHandle, ownerContextId: string, inputPath: string): Promise<string> {
    const sourceRecord = await this.requireSource(source);
    const [path] = await canonicalizeFileSet(sourceRecord.workspacePath, [inputPath]);
    const active = await this.activeForOwner(source, ownerContextId);
    if (!active || active.record.phase !== "active") throw new Error("Shared source mutation requires an active file-set claim.");
    if (!active.record.paths.some((root) => pathCovered(root, path))) {
      throw new Error(`Path ${path} is outside active claim ${active.record.claimId}.`);
    }
    return path!;
  }

  async recordOwnedMutation(source: SourceWorkspaceHandle, ownerContextId: string, inputPath: string): Promise<void> {
    const path = await this.authorizePath(source, ownerContextId, inputPath);
    const sourceRecord = await this.requireSource(source);
    const active = await this.activeForOwner(source, ownerContextId);
    if (!active || active.record.phase !== "active") throw new Error("Shared source mutation claim is no longer active.");
    const fingerprints = await fingerprintSet(sourceRecord.workspacePath, active.record.paths);
    const at = this.now();
    await this.store.update(source.sourceId, (record) => ({
      ...record,
      claims: record.claims.map((claim): PersistedFileSetClaimV1 => claim.claimId === active.record.claimId && claim.phase === "active"
        ? { ...claim, fingerprints, mutatedPaths: [...new Set([...claim.mutatedPaths, path])].sort() }
        : claim),
      updatedAt: at,
    }));
  }

  async verifyOwnedState(handle: CheckpointableFileSetClaim): Promise<ActiveFileSetClaim> {
    const active = await this.requireActive(handle);
    const sourceRecord = await this.requireSource(active.source);
    const observed = await fingerprintSet(sourceRecord.workspacePath, active.record.paths);
    if (!sameFingerprints(active.record.fingerprints, observed)) {
      await this.breach(handle, "A claimed path changed outside a recorded owner mutation.");
      throw new Error(`File-set claim ${handle.claimId} was breached by an unowned mutation.`);
    }
    return active;
  }

  async beginCheckpoint(handle: CheckpointableFileSetClaim, operationId: string): Promise<ActiveFileSetClaim> {
    const active = await this.verifyOwnedState(handle);
    if (active.record.phase !== "active") throw new Error(`File-set claim ${handle.claimId} is already checkpointing.`);
    const at = this.now();
    const source = await this.store.update(active.source.sourceId, (record) => ({
      ...record,
      claims: record.claims.map((claim): PersistedFileSetClaimV1 => claim.claimId === handle.claimId && claim.phase === "active"
        ? { ...claim, phase: "checkpointing", operationId }
        : claim),
      updatedAt: at,
    }));
    const next = source.claims.find((claim) => claim.claimId === handle.claimId);
    if (!next || next.phase !== "checkpointing") throw new Error(`Unable to enter checkpointing for ${handle.claimId}.`);
    return { handle, source: active.source, record: next };
  }

  async releaseAfterCheckpoint(handle: CheckpointableFileSetClaim, operationId: string): Promise<void> {
    const active = await this.requireActive(handle);
    if (active.record.phase !== "checkpointing" || active.record.operationId !== operationId) {
      throw new Error(`Checkpoint operation ${operationId} does not own claim ${handle.claimId}.`);
    }
    await this.release(active, operationId);
  }

  async releaseUnused(handle: CheckpointableFileSetClaim): Promise<void> {
    const active = await this.verifyOwnedState(handle);
    if (active.record.phase !== "active") throw new Error("A checkpointing claim cannot be released without its receipt.");
    if (active.record.mutatedPaths.length) throw new Error("Cannot release a file-set claim after source mutation without checkpointing.");
    await this.release(active);
  }

  async settleInterruptedCheckpoint(
    source: SourceWorkspaceHandle,
    claimId: string,
    operationId: string,
  ): Promise<void> {
    const at = this.now();
    await this.store.update(source.sourceId, (record) => ({
      ...record,
      claims: record.claims.map((claim): PersistedFileSetClaimV1 => {
        if (claim.claimId !== claimId) return claim;
        if (claim.phase !== "interrupted" || claim.priorPhase !== "checkpointing" || claim.recovery?.operationId !== operationId) {
          throw new Error(`Interrupted claim ${claimId} is not bound to checkpoint ${operationId}.`);
        }
        return { ...claimBase(claim), phase: "released", releasedAt: at, checkpointOperationId: operationId };
      }),
      updatedAt: at,
    }));
  }

  async breach(handle: CheckpointableFileSetClaim, reason: string): Promise<void> {
    const active = await this.requireActive(handle);
    const at = this.now();
    await this.store.update(active.source.sourceId, (record) => ({
      ...record,
      claims: record.claims.map((claim): PersistedFileSetClaimV1 => claim.claimId === handle.claimId
        ? { ...claimBase(claim), phase: "breached", reason, observedAt: at }
        : claim),
      updatedAt: at,
    }));
    this.active.get(active.source.sourceId)?.delete(handle.claimId);
    await this.schedule(active.source);
  }

  private async release(active: ActiveFileSetClaim, checkpointOperationId?: string): Promise<void> {
    const at = this.now();
    await this.store.update(active.source.sourceId, (record) => ({
      ...record,
      claims: record.claims.map((claim): PersistedFileSetClaimV1 => claim.claimId === active.handle.claimId
        ? {
            ...claimBase(claim),
            phase: "released",
            releasedAt: at,
            ...(checkpointOperationId ? { checkpointOperationId } : {}),
          }
        : claim),
      updatedAt: at,
    }));
    this.active.get(active.source.sourceId)?.delete(active.handle.claimId);
    await this.schedule(active.source);
  }

  private schedule(source: SourceWorkspaceHandle): Promise<void> {
    const prior = (this.scheduling.get(source.sourceId) ?? Promise.resolve()).catch(() => undefined);
    const next = prior.then(() => this.drain(source));
    this.scheduling.set(source.sourceId, next);
    return next.finally(() => {
      if (this.scheduling.get(source.sourceId) === next) this.scheduling.delete(source.sourceId);
    });
  }

  private async drain(source: SourceWorkspaceHandle): Promise<void> {
    const queue = this.waiters.get(source.sourceId) ?? [];
    if (!queue.length) return;
    const sourceRecord = await this.requireSource(source);
    const activeIds = this.active.get(source.sourceId) ?? new Set<string>();
    const activeClaims = sourceRecord.claims.filter((claim) => activeIds.has(claim.claimId) && (claim.phase === "active" || claim.phase === "checkpointing"));
    const earlierBlocked: PersistedFileSetClaimV1[] = [];
    for (const waiter of [...queue]) {
      const current = (await this.requireSource(source)).claims.find((claim) => claim.claimId === waiter.claimId);
      if (!current || current.phase !== "queued") {
        this.removeWaiter(waiter);
        continue;
      }
      if (current.paths.some((path) => activeClaims.some((claim) => setsOverlap([path], claim.paths)))
        || earlierBlocked.some((claim) => setsOverlap(current.paths, claim.paths))) {
        earlierBlocked.push(current);
        continue;
      }
      const baseline = await this.verifyBaseline(source, current.paths);
      const fingerprints = await fingerprintSet(sourceRecord.workspacePath, current.paths);
      const recovery = [...sourceRecord.claims].reverse().find((claim) =>
        claim.phase === "interrupted"
        && claim.ownerContextId === current.ownerContextId
        && claim.targetChangeId === current.targetChangeId
        && samePaths(claim.paths, current.paths)
        && claim.recovery !== undefined
        && sameFingerprints(claim.recovery.fingerprints, fingerprints),
      );
      const recoveryEvidence = recovery?.phase === "interrupted" ? recovery.recovery : undefined;
      const at = this.now();
      if (baseline.changedPaths.length && !recoveryEvidence) {
        const reason = `Claimed paths contain pre-existing unowned working-change content: ${baseline.changedPaths.join(", ")}`;
        await this.store.update(source.sourceId, (record) => ({
          ...record,
          claims: record.claims.map((claim): PersistedFileSetClaimV1 => claim.claimId === current.claimId && claim.phase === "queued"
            ? { ...claimBase(claim), phase: "breached", reason, observedAt: at }
            : claim),
          updatedAt: at,
        }));
        this.removeWaiter(waiter);
        waiter.reject(new Error(reason));
        continue;
      }
      if (!/^[a-f0-9]{64}$/.test(baseline.patchHash)) throw new Error("File-set baseline verifier returned an invalid patch hash.");
      const mutatedPaths = recoveryEvidence?.mutatedPaths ?? [];
      await this.store.update(source.sourceId, (record) => ({
        ...record,
        claims: record.claims.map((claim): PersistedFileSetClaimV1 => claim.claimId === current.claimId && claim.phase === "queued"
          ? { ...claim, phase: "active", workingChangeId: baseline.workingChangeId, acquiredAt: at, fingerprints, baselinePatchHash: baseline.patchHash, mutatedPaths }
          : claim),
        updatedAt: at,
      }));
      activeIds.add(current.claimId);
      activeClaims.push({ ...current, workingChangeId: baseline.workingChangeId, phase: "active", acquiredAt: at, fingerprints, baselinePatchHash: baseline.patchHash, mutatedPaths });
      this.active.set(source.sourceId, activeIds);
      this.removeWaiter(waiter);
      waiter.resolve(checkpointableFileSetClaim(fileSetClaimId(current.claimId)));
    }
  }

  private async cancelQueued(waiter: Waiter, reason: string): Promise<void> {
    this.removeWaiter(waiter);
    const at = this.now();
    await this.store.update(waiter.source.sourceId, (record) => ({
      ...record,
      claims: record.claims.map((claim): PersistedFileSetClaimV1 => claim.claimId === waiter.claimId && claim.phase === "queued"
        ? { ...claimBase(claim), phase: "interrupted", priorPhase: "queued", reason, interruptedAt: at }
        : claim),
      updatedAt: at,
    }));
    waiter.reject(abortError());
    await this.schedule(waiter.source);
  }

  private removeWaiter(waiter: Waiter): void {
    const queue = this.waiters.get(waiter.source.sourceId);
    if (queue) this.waiters.set(waiter.source.sourceId, queue.filter((candidate) => candidate !== waiter));
    if (waiter.abort && waiter.signal) waiter.signal.removeEventListener("abort", waiter.abort);
  }

  private async requireSource(source: SourceWorkspaceHandle): Promise<PersistedSharedSourceV1> {
    const record = await this.store.get(source.sourceId);
    if (!record) throw new Error(`Unknown shared source: ${source.sourceId}`);
    return record;
  }
}

export async function canonicalizeFileSet(workspacePath: string, inputs: readonly string[]): Promise<string[]> {
  if (!inputs.length) throw new Error("A shared file-set request must contain at least one path.");
  const root = await realpath(workspacePath);
  const canonical: string[] = [];
  for (const input of inputs) {
    const normalized = input.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
      throw new Error(`Invalid repository-relative path: ${input}`);
    }
    const candidate = resolve(root, normalized);
    if (!inside(root, candidate)) throw new Error(`File-set path escapes the source workspace: ${input}`);
    let existing = candidate;
    const missing: string[] = [];
    while (true) {
      try {
        const resolved = await realpath(existing);
        if (!inside(root, resolved)) throw new Error(`File-set path resolves outside the source workspace: ${input}`);
        const final = resolve(resolved, ...missing.reverse());
        if (!inside(root, final)) throw new Error(`File-set path escapes the source workspace: ${input}`);
        canonical.push(relative(root, final).split(sep).join("/"));
        break;
      } catch (error) {
        if (!isMissing(error)) throw error;
        const parent = dirname(existing);
        if (parent === existing) throw error;
        missing.push(relative(parent, existing));
        existing = parent;
      }
    }
  }
  const sorted = [...new Set(canonical)].sort();
  return sorted.filter((path, index) => !sorted.slice(0, index).some((parent) => pathCovered(parent, path)));
}

export function setsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => pathCovered(a, b) || pathCovered(b, a)));
}

function claimBase(claim: PersistedFileSetClaimV1) {
  return {
    claimId: claim.claimId,
    ownerContextId: claim.ownerContextId,
    rootSessionId: claim.rootSessionId,
    targetChangeId: claim.targetChangeId,
    baseChangeId: claim.baseChangeId,
    workingChangeId: claim.workingChangeId,
    paths: claim.paths,
    queuedAt: claim.queuedAt,
  };
}

function pathCovered(root: string, path: string): boolean {
  return root === path || path.startsWith(`${root}/`);
}

async function fingerprintSet(workspacePath: string, paths: readonly string[]): Promise<PersistedPathFingerprintV1[]> {
  return Promise.all(paths.map(async (path) => ({ path, digest: await fingerprint(resolve(workspacePath, path)) })));
}

async function fingerprint(path: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(current: string, name: string): Promise<void> {
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        hash.update("link\0").update(name).update("\0").update(await readlink(current)).update("\0");
      } else if (stat.isDirectory()) {
        hash.update("dir\0").update(name).update("\0");
        for (const child of (await readdir(current)).sort()) await visit(resolve(current, child), `${name}/${child}`);
      } else if (stat.isFile()) {
        hash.update("file\0").update(name).update("\0").update(await readFile(current)).update("\0");
      } else {
        hash.update("other\0").update(name).update("\0");
      }
    } catch (error) {
      if (isMissing(error)) hash.update("missing\0").update(name).update("\0");
      else throw error;
    }
  }
  await visit(path, ".");
  return hash.digest("hex");
}

function sameFingerprints(left: readonly PersistedPathFingerprintV1[], right: readonly PersistedPathFingerprintV1[]): boolean {
  return left.length === right.length && left.every((value, index) => value.path === right[index]?.path && value.digest === right[index]?.digest);
}
function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function inside(root: string, path: string): boolean { return path === root || path.startsWith(`${root}${sep}`); }
function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR");
}
function abortError(): Error { return Object.assign(new Error("File-set acquisition aborted."), { name: "AbortError" }); }
