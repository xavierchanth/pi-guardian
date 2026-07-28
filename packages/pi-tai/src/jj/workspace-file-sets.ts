import { createHash, randomUUID } from "node:crypto";
import { SharedFileSetCoordinator, type AcquireFileSetInput, type ActiveFileSetClaim } from "../concurrency/file-sets.ts";
import { childContextId } from "../concurrency/ids.ts";
import { changeDescription, changeId, type ChangeDescription, type CheckpointableFileSetClaim, type SourceWorkspaceHandle, type WorkspaceId } from "./domain.ts";
import type { PersistedSharedSourceV1, SharedSourceStore } from "./persistence.ts";
import { exactChange, literalRootFileset } from "./repository.ts";
import type { IsolatedWorkspaceStore } from "./workspace-persistence.ts";
import type { JjWorkspaceRepositoryKernel } from "./workspace-repository.ts";

export class WorkspaceFileSetCoordinator {
  private readonly adapter: WorkspaceClaimStoreAdapter;
  private readonly coordinator: SharedFileSetCoordinator;
  private readonly repository: JjWorkspaceRepositoryKernel;
  private readonly workspaces: IsolatedWorkspaceStore;
  private readonly now: () => string;

  constructor(options: { workspaces: IsolatedWorkspaceStore; repository: JjWorkspaceRepositoryKernel; now?: () => string }) {
    this.workspaces = options.workspaces;
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date().toISOString());
    this.adapter = new WorkspaceClaimStoreAdapter(options.workspaces);
    this.coordinator = new SharedFileSetCoordinator({
      store: this.adapter,
      verifyBaseline: async (source, paths) => {
        const id = source.sourceId as unknown as WorkspaceId;
        const filesets = paths.map(literalRootFileset);
        const record = await this.requireWorkspace(id);
        const workingChangeId = record.identity.expectedHeadChangeId;
        const patch = await this.repository.patchEvidence(id, exactChange(changeId(workingChangeId)), filesets);
        return { workingChangeId, patchHash: hash(patch), changedPaths: await this.repository.changedPaths(id, exactChange(changeId(workingChangeId)), filesets) };
      },
      ...(options.now ? { now: options.now } : {}),
    });
  }

  async assignTarget(id: WorkspaceId, input: { ownerContextId: string; description: ChangeDescription }): Promise<string> {
    const record = await this.requireWorkspace(id);
    const existing = [...record.targets].reverse().find((target) => target.ownerContextId === input.ownerContextId);
    if (existing) return existing.changeId;
    if (record.writer.phase !== "available") throw new Error("Workspace file-target assignment requires legacy writer authority to be settled.");
    const operationId = `jjop-${randomUUID()}`;
    const at = this.now();
    return this.repository.mutate(id, async (identity) => {
      await this.repository.run(identity, ["new", "--no-edit", "--insert-before", exactChange(changeId(identity.expectedHeadChangeId)), "--message", input.description]);
      const target = await this.repository.resolveRevision(id, `parents(${exactChange(changeId(identity.expectedHeadChangeId))})`);
      if (target.changeId === identity.expectedHeadChangeId || !target.empty) throw new Error("Workspace target allocation did not create one empty assigned target.");
      await this.workspaces.update(id, (current) => {
        if (current.phase !== "active" || current.identity.expectedHeadChangeId !== identity.expectedHeadChangeId) throw new Error("Workspace identity changed during target assignment.");
        return { ...current, targets: [...current.targets, { changeId: target.changeId, baseChangeId: identity.expectedHeadChangeId, workingChangeId: identity.expectedHeadChangeId, ownerContextId: childContextId(input.ownerContextId), description: changeDescription(input.description), insertOperationId: operationId, createdAt: at }], updatedAt: this.now() };
      });
      return target.changeId;
    });
  }

  acquire(id: WorkspaceId, input: Omit<AcquireFileSetInput, "rootSessionId">): Promise<CheckpointableFileSetClaim> {
    return this.requireWorkspace(id).then((record) => this.coordinator.acquire(sourceHandle(id), { ...input, rootSessionId: record.identity.rootSessionId }));
  }
  activeForOwner(id: WorkspaceId, ownerContextId: string): Promise<ActiveFileSetClaim | undefined> { return this.coordinator.activeForOwner(sourceHandle(id), ownerContextId); }
  requireActive(handle: CheckpointableFileSetClaim): Promise<ActiveFileSetClaim> { return this.coordinator.requireActive(handle); }
  authorizePath(id: WorkspaceId, ownerContextId: string, path: string): Promise<string> { return this.coordinator.authorizePath(sourceHandle(id), ownerContextId, path); }
  recordOwnedMutation(id: WorkspaceId, ownerContextId: string, path: string): Promise<void> { return this.coordinator.recordOwnedMutation(sourceHandle(id), ownerContextId, path); }
  beginCheckpoint(handle: CheckpointableFileSetClaim, operationId: string): Promise<ActiveFileSetClaim> { return this.coordinator.beginCheckpoint(handle, operationId); }
  releaseAfterCheckpoint(handle: CheckpointableFileSetClaim, operationId: string): Promise<void> { return this.coordinator.releaseAfterCheckpoint(handle, operationId); }
  releaseUnused(handle: CheckpointableFileSetClaim): Promise<void> { return this.coordinator.releaseUnused(handle); }
  interrupt(id: WorkspaceId, reason: string): Promise<void> { return this.workspaces.interruptLiveClaims(id, reason).then(() => undefined); }

  private async requireWorkspace(id: WorkspaceId) { const record = await this.workspaces.get(id); if (!record || record.phase !== "active") throw new Error(`Workspace ${id} is not active.`); return record; }
}

class WorkspaceClaimStoreAdapter implements SharedSourceStore {
  private readonly workspaces: IsolatedWorkspaceStore;
  constructor(workspaces: IsolatedWorkspaceStore) { this.workspaces = workspaces; }
  create(): Promise<void> { throw new Error("Workspace claim adapter cannot create workspaces."); }
  async get(sourceId: string): Promise<PersistedSharedSourceV1 | undefined> { const record = await this.workspaces.get(sourceId); return record?.phase === "active" ? project(record) : undefined; }
  async list(): Promise<PersistedSharedSourceV1[]> { return (await this.workspaces.list()).filter((record) => record.phase === "active").map((record) => project(record as Extract<typeof record, { phase: "active" }>)); }
  async update(sourceId: string, reducer: (record: PersistedSharedSourceV1) => PersistedSharedSourceV1): Promise<PersistedSharedSourceV1> {
    let projected!: PersistedSharedSourceV1;
    await this.workspaces.update(sourceId, (record) => {
      if (record.phase !== "active") throw new Error(`Workspace ${sourceId} is not active.`);
      projected = reducer(project(record));
      if (projected.sourceId !== sourceId || projected.targets.some((target) => target.baseChangeId !== record.identity.expectedHeadChangeId || target.workingChangeId !== record.identity.expectedHeadChangeId)) throw new Error("Workspace claim update changed stable identity.");
      return { ...record, targets: projected.targets, claims: projected.claims, updatedAt: projected.updatedAt };
    });
    return projected;
  }
  async interruptLiveClaims(sourceId: string, reason: string, at?: string): Promise<PersistedSharedSourceV1> { await this.workspaces.interruptLiveClaims(sourceId, reason, at); const value = await this.get(sourceId); if (!value) throw new Error(`Workspace ${sourceId} is not active.`); return value; }
}

function project(record: Extract<Awaited<ReturnType<IsolatedWorkspaceStore["get"]>>, { phase: "active" }>): PersistedSharedSourceV1 {
  return {
    version: 1,
    sourceId: record.identity.workspaceId,
    repositoryRoot: record.identity.path,
    workspacePath: record.identity.path,
    workspaceName: record.identity.name,
    targets: record.targets,
    claims: record.claims,
    operations: [],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
function sourceHandle(id: WorkspaceId): SourceWorkspaceHandle { return { kind: "source_workspace", sourceId: String(id) } as SourceWorkspaceHandle; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
