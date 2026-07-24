import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { absolutePath, changeId, sourceWorkspaceHandle, sourceWorkspaceId, type ChangeId, type SourceWorkspaceHandle } from "./domain.ts";
import {
  renderJjExecutionFailure,
  type JjAccess,
  type JjExecutionResult,
  type JjExecutor,
} from "./executor.ts";
import {
  type PersistedSharedSourceV1,
  type SharedSourceStore,
} from "./persistence.ts";

const CHANGE_TEMPLATE = 'change_id ++ "|" ++ commit_id ++ "|" ++ if(empty, "empty", "nonempty") ++ "|" ++ if(conflict, "conflicted", "clean") ++ "|" ++ if(immutable, "immutable", "mutable") ++ "|" ++ parents.map(|p| p.change_id()).join(",") ++ "|" ++ description.first_line() ++ "\\n"';
const CHANGE_ID_TEMPLATE = 'change_id ++ "\\n"';
const WORKSPACE_TEMPLATE = 'name ++ "|" ++ target.change_id() ++ "\\n"';
const OPERATION_TEMPLATE = 'id ++ "\\n"';
const repositoryMutexes = new Map<string, Promise<void>>();

export interface ResolvedJjChange {
  readonly changeId: ChangeId;
  readonly commitId: string;
  readonly empty: boolean;
  readonly conflicted: boolean;
  readonly immutable: boolean;
  readonly parentChangeIds: readonly ChangeId[];
  readonly description: string;
}

export interface SourceInspection {
  readonly source: PersistedSharedSourceV1;
  readonly current: ResolvedJjChange;
  readonly privateCommitSelector?: string;
  readonly jjOperationId: string;
}

export class JjCommandError extends Error {
  readonly result: Extract<JjExecutionResult, { kind: "failure" }>;
  readonly args: readonly string[];
  readonly mutationStarted: boolean;

  constructor(args: readonly string[], result: Extract<JjExecutionResult, { kind: "failure" }>, mutationStarted = false) {
    const detail = result.stderr.trim() || renderJjExecutionFailure(result.failure);
    super(`jj argv ${JSON.stringify(args)} failed: ${detail}`);
    this.name = "JjCommandError";
    this.args = args;
    this.result = result;
    this.mutationStarted = mutationStarted;
  }
}

export class JjRepositoryKernel {
  private readonly executor: JjExecutor;
  private readonly store: SharedSourceStore;
  private readonly now: () => string;

  constructor(options: { executor: JjExecutor; store: SharedSourceStore; now?: () => string }) {
    this.executor = options.executor;
    this.store = options.store;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async openSource(cwd: string): Promise<SourceWorkspaceHandle> {
    const workspacePath = resolve(singleLine(await this.executeAt(cwd, ["root"], "read"), "JJ workspace root"));
    const currentId = changeId(singleLine(await this.executeAt(workspacePath, [
      "log", "--revision", "@", "--no-graph", "--template", CHANGE_ID_TEMPLATE,
    ], "read"), "source working-copy Change ID"));
    const workspaceName = resolveCurrentWorkspace(await this.executeAt(workspacePath, [
      "workspace", "list", "--template", WORKSPACE_TEMPLATE,
    ], "read"), currentId);
    const repositoryRoot = await resolveRepositoryStore(workspacePath);
    const sourceId = `source-${createHash("sha256").update(repositoryRoot).update("\0").update(workspaceName).digest("hex").slice(0, 32)}`;
    const existing = await this.store.get(sourceId);
    if (existing) {
      if (existing.repositoryRoot !== repositoryRoot || existing.workspacePath !== workspacePath || existing.workspaceName !== workspaceName) {
        throw new Error(`Shared source identity collision for ${sourceId}.`);
      }
      return sourceWorkspaceHandle(sourceWorkspaceId(sourceId));
    }
    const at = this.now();
    const record: PersistedSharedSourceV1 = {
      version: 1,
      sourceId,
      repositoryRoot,
      workspacePath,
      workspaceName,
      targets: [],
      claims: [],
      operations: [],
      createdAt: at,
      updatedAt: at,
    };
    try {
      await this.store.create(record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raced = await this.store.get(sourceId);
      if (!raced) throw error;
    }
    return sourceWorkspaceHandle(sourceWorkspaceId(sourceId));
  }

  async inspect(source: SourceWorkspaceHandle): Promise<SourceInspection> {
    const record = await this.requireSource(source);
    const [current, jjOperationId, privateCommitSelector] = await Promise.all([
      this.resolveRevision(record, "@"),
      this.operationId(record),
      this.optional(record, ["config", "get", "git.private-commits"]),
    ]);
    return { source: record, current, jjOperationId, ...(privateCommitSelector ? { privateCommitSelector: privateCommitSelector.trim() } : {}) };
  }

  async resolveChange(source: SourceWorkspaceHandle, tracked: ChangeId): Promise<ResolvedJjChange> {
    return this.resolveRevision(await this.requireSource(source), exactChange(tracked));
  }

  async currentChangeId(source: SourceWorkspaceHandle): Promise<ChangeId> {
    return (await this.resolveRevision(await this.requireSource(source), "@")).changeId;
  }

  async operationIdFor(source: SourceWorkspaceHandle): Promise<string> {
    return this.operationId(await this.requireSource(source));
  }

  async patchEvidence(source: SourceWorkspaceHandle, revision: string, filesets: readonly string[] = []): Promise<string> {
    const record = await this.requireSource(source);
    return this.execute(record, ["diff", "--revision", revision, "--git", ...filesets], "read");
  }

  async changedPaths(source: SourceWorkspaceHandle, revision: string, filesets: readonly string[] = []): Promise<string[]> {
    const record = await this.requireSource(source);
    return lines(await this.execute(record, ["diff", "--revision", revision, "--name-only", ...filesets], "read")).sort();
  }

  async runMutation(source: SourceWorkspaceHandle, args: readonly string[]): Promise<string> {
    const record = await this.requireSource(source);
    return this.execute(record, args, "write", true);
  }

  async withRepositoryMutation<T>(source: SourceWorkspaceHandle, fn: () => Promise<T>): Promise<T> {
    const record = await this.requireSource(source);
    const key = record.repositoryRoot;
    const prior = (repositoryMutexes.get(key) ?? Promise.resolve()).catch(() => undefined);
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const chain = prior.then(() => gate);
    repositoryMutexes.set(key, chain);
    await prior;
    try {
      return await fn();
    } finally {
      release();
      if (repositoryMutexes.get(key) === chain) repositoryMutexes.delete(key);
    }
  }

  async startOperation(
    source: SourceWorkspaceHandle,
    kind: "ensure_wip" | "insert_change" | "checkpoint_change",
    idempotencyKey: string,
  ): Promise<{ operationId: string; beforeJjOperationId: string }> {
    const beforeJjOperationId = await this.operationIdFor(source);
    const operationId = `jjop-${randomUUID()}`;
    const at = this.now();
    await this.store.update(source.sourceId, (record) => ({
      ...record,
      operations: [...record.operations, {
        phase: "started",
        operationId,
        kind,
        idempotencyKey,
        startedAt: at,
        beforeJjOperationId,
      }],
      updatedAt: at,
    }));
    return { operationId, beforeJjOperationId };
  }

  async completeOperation(source: SourceWorkspaceHandle, operationId: string, receipt: unknown): Promise<void> {
    const afterJjOperationId = await this.operationIdFor(source);
    const at = this.now();
    await this.store.update(source.sourceId, (record) => ({
      ...record,
      operations: record.operations.map((operation) => operation.operationId === operationId
        ? { ...operation, phase: "completed", completedAt: at, afterJjOperationId, receipt }
        : operation),
      updatedAt: at,
    }));
  }

  async blockOperation(source: SourceWorkspaceHandle, operationId: string, blocker: unknown): Promise<void> {
    const at = this.now();
    await this.store.update(source.sourceId, (record) => ({
      ...record,
      operations: record.operations.map((operation) => operation.operationId === operationId
        ? { ...operation, phase: "blocked", blockedAt: at, blocker }
        : operation),
      updatedAt: at,
    }));
  }

  async unknownOperation(source: SourceWorkspaceHandle, operationId: string, reason: string): Promise<void> {
    const at = this.now();
    await this.store.update(source.sourceId, (record) => ({
      ...record,
      operations: record.operations.map((operation) => operation.operationId === operationId
        ? { ...operation, phase: "unknown", stoppedAt: at, reason }
        : operation),
      updatedAt: at,
    }));
  }

  storeForTests(): SharedSourceStore { return this.store; }

  private async requireSource(source: SourceWorkspaceHandle): Promise<PersistedSharedSourceV1> {
    const record = await this.store.get(source.sourceId);
    if (!record) throw new Error(`Unknown shared source handle: ${source.sourceId}`);
    return record;
  }

  private async resolveRevision(record: PersistedSharedSourceV1, revision: string): Promise<ResolvedJjChange> {
    const row = singleLine(await this.execute(record, [
      "log", "--revision", revision, "--no-graph", "--template", CHANGE_TEMPLATE,
    ], "read"), `revision ${revision}`);
    const [id, commitId, empty, conflict, mutability, parents, ...descriptionParts] = row.split("|");
    if (!id || !commitId || !["empty", "nonempty"].includes(empty ?? "") || !["clean", "conflicted"].includes(conflict ?? "") || !["mutable", "immutable"].includes(mutability ?? "")) {
      throw new Error(`Invalid JJ change row for ${revision}.`);
    }
    return {
      changeId: changeId(id),
      commitId,
      empty: empty === "empty",
      conflicted: conflict === "conflicted",
      immutable: mutability === "immutable",
      parentChangeIds: parents ? parents.split(",").map(changeId) : [],
      description: descriptionParts.join("|"),
    };
  }

  private operationId(record: PersistedSharedSourceV1): Promise<string> {
    return this.execute(record, ["--ignore-working-copy", "operation", "log", "--limit", "1", "--no-graph", "--template", OPERATION_TEMPLATE], "read")
      .then((output) => singleLine(output, "JJ operation ID"));
  }

  private async optional(record: PersistedSharedSourceV1, args: readonly string[]): Promise<string | undefined> {
    const result = await this.executor.execute({ cwd: absolutePath(record.workspacePath), args, access: "read" });
    return result.kind === "success" ? result.stdout : undefined;
  }

  private async executeAt(cwd: string, args: readonly string[], access: JjAccess): Promise<string> {
    const result = await this.executor.execute({ cwd: absolutePath(resolve(cwd)), args, access });
    if (result.kind === "success") return result.stdout;
    throw new JjCommandError(args, result);
  }

  private async execute(
    record: PersistedSharedSourceV1,
    args: readonly string[],
    access: JjAccess,
    mutationStarted = false,
  ): Promise<string> {
    const result = await this.executor.execute({ cwd: absolutePath(record.workspacePath), args, access });
    if (result.kind === "success") return result.stdout;
    throw new JjCommandError(args, result, mutationStarted);
  }
}

export function exactChange(id: ChangeId): string {
  return `exactly(change_id(${id}), 1)`;
}

export function literalRootFileset(path: string): string {
  const escaped = path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `root:"${escaped}"`;
}

async function resolveRepositoryStore(workspacePath: string): Promise<string> {
  try {
    return await realpath(join(workspacePath, ".jj", "repo"));
  } catch {
    // Linked workspaces have a .jj file. Their shared-source use is intentionally
    // unsupported until M3 workspace writer leases are active.
    throw new Error(`Shared-source coordination requires the repository's primary JJ workspace: ${workspacePath}`);
  }
}

function resolveCurrentWorkspace(output: string, currentId: ChangeId): string {
  const matches = lines(output).map((row) => row.split("|", 2)).filter(([, id]) => id === currentId).map(([name]) => name!);
  if (matches.length !== 1) throw new Error(`Unable to resolve exactly one current JJ workspace for ${currentId}.`);
  return matches[0]!;
}
function singleLine(output: string, label: string): string {
  const values = lines(output);
  if (values.length !== 1) throw new Error(`Unable to resolve exactly one ${label}.`);
  return values[0]!;
}
function lines(output: string): string[] {
  return output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}
