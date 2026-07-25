import { createHash } from "node:crypto";
import { absolutePath, changeId, type ChangeId, type WorkspaceId } from "./domain.ts";
import { type JjAccess, type JjExecutor, renderJjExecutionFailure } from "./executor.ts";
import type { SharedSourceStore } from "./persistence.ts";
import { exactChange, withRepositoryMutation, type ResolvedJjChange } from "./repository.ts";
import type { IsolatedWorkspaceStore, PersistedWorkspaceIdentityV1 } from "./workspace-persistence.ts";

const CHANGE_TEMPLATE = 'change_id ++ "|" ++ commit_id ++ "|" ++ if(empty, "empty", "nonempty") ++ "|" ++ if(conflict, "conflicted", "clean") ++ "|" ++ if(immutable, "immutable", "mutable") ++ "|" ++ parents.map(|p| p.change_id()).join(",") ++ "|" ++ description.first_line() ++ "\\n"';
const ID_TEMPLATE = 'change_id ++ "\\n"';
const OPERATION_TEMPLATE = 'id ++ "\\n"';

export interface WorkspaceRangeEntry extends ResolvedJjChange { readonly changedPaths: readonly string[]; }
export interface WorkspaceInspection { readonly identity: PersistedWorkspaceIdentityV1; readonly head: ResolvedJjChange; readonly operationId: string; }

export class JjWorkspaceRepositoryKernel {
  private readonly options: { executor: JjExecutor; workspaces: IsolatedWorkspaceStore; sources: SharedSourceStore };
  constructor(options: { executor: JjExecutor; workspaces: IsolatedWorkspaceStore; sources: SharedSourceStore }) { this.options = options; }

  async inspect(workspaceId: WorkspaceId): Promise<WorkspaceInspection> {
    const identity = await this.identity(workspaceId);
    const [head, operationId] = await Promise.all([this.resolve(identity, "@"), this.operationId(identity)]);
    return { identity, head, operationId };
  }
  async resolveTracked(workspaceId: WorkspaceId, id: ChangeId): Promise<ResolvedJjChange> { return this.resolve(await this.identity(workspaceId), exactChange(id)); }
  async resolveRevision(workspaceId: WorkspaceId, revision: string): Promise<ResolvedJjChange> { return this.resolve(await this.identity(workspaceId), revision); }
  async currentChangeId(workspaceId: WorkspaceId): Promise<ChangeId> { return (await this.resolveRevision(workspaceId, "@")).changeId; }
  async changedPaths(workspaceId: WorkspaceId, revision: string, filesets: readonly string[] = []): Promise<string[]> { const identity = await this.identity(workspaceId); return lines(await this.execute(identity, ["diff", "--revision", revision, "--name-only", ...filesets], "read")).sort(); }
  async patchEvidence(workspaceId: WorkspaceId, revision: string, filesets: readonly string[] = []): Promise<string> { const identity = await this.identity(workspaceId); return this.execute(identity, ["diff", "--revision", revision, "--git", ...filesets], "read"); }
  async range(workspaceId: WorkspaceId, root: ChangeId, head: ChangeId): Promise<WorkspaceRangeEntry[]> {
    const identity = await this.identity(workspaceId);
    const revisions = `${exactChange(root)}::${exactChange(head)}`;
    const rows = lines(await this.execute(identity, ["log", "--revision", revisions, "--no-graph", "--reversed", "--template", CHANGE_TEMPLATE], "read"));
    const output: WorkspaceRangeEntry[] = [];
    for (const row of rows) { const resolved = parseChange(row); output.push({ ...resolved, changedPaths: lines(await this.execute(identity, ["diff", "--revision", exactChange(resolved.changeId), "--name-only"], "read")).sort() }); }
    return output;
  }
  async foreignDescendants(workspaceId: WorkspaceId, root: ChangeId, head: ChangeId): Promise<ChangeId[]> {
    const identity = await this.identity(workspaceId);
    return lines(await this.execute(identity, ["log", "--revision", `${exactChange(root)}:: ~ ::${exactChange(head)}`, "--no-graph", "--template", ID_TEMPLATE], "read")).map(changeId);
  }
  async patchHash(workspaceId: WorkspaceId, revision: string): Promise<string> {
    const identity = await this.identity(workspaceId); const patch = await this.execute(identity, ["diff", "--revision", revision, "--git"], "read"); return createHash("sha256").update(patch).digest("hex");
  }
  async conflicts(workspaceId: WorkspaceId, revision: string): Promise<string[]> {
    const identity = await this.identity(workspaceId);
    const result = await this.options.executor.execute({ cwd: absolutePath(identity.path), args: ["--ignore-working-copy", "resolve", "--list", "--revision", revision], access: "read" });
    if (result.kind === "success") return lines(result.stdout);
    if (result.stderr.includes("No conflicts found")) return [];
    throw new Error(result.stderr.trim() || renderJjExecutionFailure(result.failure));
  }
  async mutate<T>(workspaceId: WorkspaceId, fn: (identity: PersistedWorkspaceIdentityV1) => Promise<T>): Promise<T> {
    const identity = await this.identity(workspaceId); const source = await this.options.sources.get(identity.sourceId); if (!source) throw new Error(`Unknown source for workspace ${workspaceId}.`); return withRepositoryMutation(source.repositoryRoot, () => fn(identity));
  }
  async run(identity: PersistedWorkspaceIdentityV1, args: readonly string[]): Promise<string> { return this.execute(identity, args, "write"); }
  async currentOperationId(identity: PersistedWorkspaceIdentityV1): Promise<string> { return this.operationId(identity); }

  private async identity(workspaceId: WorkspaceId): Promise<PersistedWorkspaceIdentityV1> { const record = await this.options.workspaces.get(workspaceId); if (!record || !("identity" in record) || !record.identity) throw new Error(`Workspace ${workspaceId} has no tracked operational identity.`); return record.identity; }
  private operationId(identity: PersistedWorkspaceIdentityV1): Promise<string> { return this.execute(identity, ["--ignore-working-copy", "operation", "log", "--limit", "1", "--no-graph", "--template", OPERATION_TEMPLATE], "read").then((value) => one(value, "JJ operation ID")); }
  private async resolve(identity: PersistedWorkspaceIdentityV1, revision: string): Promise<ResolvedJjChange> { return parseChange(one(await this.execute(identity, ["log", "--revision", revision, "--no-graph", "--template", CHANGE_TEMPLATE], "read"), `revision ${revision}`)); }
  private async execute(identity: PersistedWorkspaceIdentityV1, args: readonly string[], access: JjAccess): Promise<string> { const result = await this.options.executor.execute({ cwd: absolutePath(identity.path), args, access }); if (result.kind === "success") return result.stdout; throw new Error(`jj argv ${JSON.stringify(args)} failed: ${result.stderr.trim() || renderJjExecutionFailure(result.failure)}`); }
}
function parseChange(row: string): ResolvedJjChange { const [id, commitId, empty, conflict, mutability, parents, ...description] = row.split("|"); if (!id || !commitId || !["empty", "nonempty"].includes(empty ?? "") || !["clean", "conflicted"].includes(conflict ?? "") || !["mutable", "immutable"].includes(mutability ?? "")) throw new Error("Invalid JJ change row."); return { changeId: changeId(id), commitId, empty: empty === "empty", conflicted: conflict === "conflicted", immutable: mutability === "immutable", parentChangeIds: parents ? parents.split(",").map(changeId) : [], description: description.join("|") }; }
function lines(value: string): string[] { return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean); }
function one(value: string, label: string): string { const values = lines(value); if (values.length !== 1) throw new Error(`Unable to resolve exactly one ${label}.`); return values[0]!; }
