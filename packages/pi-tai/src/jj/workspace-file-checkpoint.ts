import { createHash, randomUUID } from "node:crypto";
import { jjOperationId } from "../concurrency/ids.ts";
import { changeId, type CheckpointableFileSetClaim, type WorkspaceId } from "./domain.ts";
import type { CheckpointChangeReceipt, JjOperationResult } from "./operations.ts";
import { complementFileset } from "./shared-checkpoint.ts";
import { exactChange, literalRootFileset } from "./repository.ts";
import type { IsolatedWorkspaceStore, PersistedWorkspaceOperationV1 } from "./workspace-persistence.ts";
import type { WorkspaceFileSetCoordinator } from "./workspace-file-sets.ts";
import type { JjWorkspaceRepositoryKernel } from "./workspace-repository.ts";

export class WorkspaceFileCheckpointer {
  private readonly workspaces: IsolatedWorkspaceStore;
  private readonly repository: JjWorkspaceRepositoryKernel;
  private readonly fileSets: WorkspaceFileSetCoordinator;
  private readonly now: () => string;
  constructor(options: { workspaces: IsolatedWorkspaceStore; repository: JjWorkspaceRepositoryKernel; fileSets: WorkspaceFileSetCoordinator; now?: () => string }) {
    this.workspaces = options.workspaces; this.repository = options.repository; this.fileSets = options.fileSets; this.now = options.now ?? (() => new Date().toISOString());
  }

  async checkpoint(id: WorkspaceId, claim: CheckpointableFileSetClaim): Promise<JjOperationResult<CheckpointChangeReceipt>> {
    const active = await this.fileSets.requireActive(claim);
    if (String(active.source.sourceId) !== String(id)) throw new Error("Workspace file claim belongs to another workspace.");
    const operationId = `jjop-${randomUUID()}`;
    return this.repository.mutate(id, async (identity) => {
      const refreshed = await this.fileSets.requireActive(claim);
      if (refreshed.record.phase !== "active") return { kind: "blocked", blocker: { kind: "unknown_partial_mutation", operationId: jjOperationId(operationId), phase: "workspace_file_checkpoint" } };
      const record = await this.workspaces.get(id);
      if (!record || record.phase !== "active") throw new Error(`Workspace ${id} is not active.`);
      const target = record.targets.find((candidate) => candidate.changeId === refreshed.record.targetChangeId && candidate.ownerContextId === refreshed.record.ownerContextId);
      if (!target || target.workingChangeId !== identity.expectedHeadChangeId || target.baseChangeId !== identity.expectedHeadChangeId) return { kind: "blocked", blocker: { kind: "foreign_work", reason: "Workspace claim no longer matches its assigned target and stable head." } };
      const wipId = changeId(identity.expectedHeadChangeId); const targetId = changeId(target.changeId);
      const current = await this.repository.currentChangeId(id); if (current !== wipId) return { kind: "blocked", blocker: { kind: "identity_mismatch", expected: wipId, observed: [current] } };
      const [wip, targetState] = await Promise.all([this.repository.resolveTracked(id, wipId), this.repository.resolveTracked(id, targetId)]);
      if (wip.conflicted || targetState.conflicted) return { kind: "blocked", blocker: { kind: "conflicted", changeIds: [wipId, targetId], paths: refreshed.record.paths } };
      const filesets = refreshed.record.paths.map(literalRootFileset);
      const changedPaths = await this.repository.changedPaths(id, exactChange(wipId), filesets);
      if (!changedPaths.length) return { kind: "blocked", blocker: { kind: "decision_required", reason: "Claimed workspace paths have no effective changes to checkpoint." } };
      const unowned = complementFileset(refreshed.record.paths); const beforeUnownedHash = hash(await this.repository.patchEvidence(id, exactChange(wipId), [unowned]));
      const beforeJjOperationId = await this.repository.currentOperationId(identity); const at = this.now();
      const operation: PersistedWorkspaceOperationV1 = { operationId, kind: "workspace_file_checkpoint", idempotencyKey: `workspace-file-checkpoint:${claim.claimId}`, startedAt: at, beforeJjOperationId, intent: { claimId: claim.claimId, workingChangeId: wipId, targetChangeId: targetId, ownerContextId: refreshed.record.ownerContextId, paths: refreshed.record.paths, mutatedPaths: refreshed.record.mutatedPaths, beforeUnownedHash }, outcome: { phase: "started", boundary: "prepared" } };
      await this.workspaces.update(id, (currentRecord) => currentRecord.phase !== "active" ? currentRecord : { ...currentRecord, operations: [...currentRecord.operations, operation], updatedAt: at });
      await this.fileSets.beginCheckpoint(claim, operationId);
      try {
        await this.boundary(id, operationId, "mutating");
        await this.repository.run(identity, ["squash", "--from", exactChange(wipId), "--into", exactChange(targetId), "--keep-emptied", ...filesets]);
        await this.boundary(id, operationId, "verifying");
        const [afterWorking, afterTarget, afterCurrent] = await Promise.all([this.repository.resolveTracked(id, wipId), this.repository.resolveTracked(id, targetId), this.repository.currentChangeId(id)]);
        const afterUnownedHash = hash(await this.repository.patchEvidence(id, exactChange(wipId), [unowned]));
        const remainingOwned = await this.repository.changedPaths(id, exactChange(wipId), filesets);
        if (afterCurrent !== wipId || afterUnownedHash !== beforeUnownedHash || remainingOwned.length) throw new Error("Workspace file checkpoint did not preserve stable working-head ownership boundaries.");
        const targetPaths = await this.repository.changedPaths(id, exactChange(targetId), filesets);
        if (changedPaths.some((path) => !targetPaths.includes(path))) throw new Error("Assigned workspace target is missing checkpointed paths.");
        const afterJjOperationId = await this.repository.currentOperationId(identity);
        const receipt: CheckpointChangeReceipt = { checkpointedChangeId: targetId, workingChangeId: wipId, claimId: claim.claimId, changedPaths, parentChangeIds: afterTarget.parentChangeIds, unownedWorkingPatchHash: afterUnownedHash, conflicted: afterWorking.conflicted || afterTarget.conflicted, operationId: jjOperationId(operationId) };
        await this.workspaces.update(id, (currentRecord) => currentRecord.phase !== "active" ? currentRecord : { ...currentRecord, operations: currentRecord.operations.map((item) => item.operationId === operationId ? { ...item, outcome: { phase: "completed", completedAt: this.now(), afterJjOperationId, receipt } } : item), updatedAt: this.now() });
        await this.fileSets.releaseAfterCheckpoint(claim, operationId);
        return { kind: "completed", receipt };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.workspaces.update(id, (currentRecord) => currentRecord.phase !== "active" ? currentRecord : { ...currentRecord, operations: currentRecord.operations.map((item) => item.operationId === operationId ? { ...item, outcome: { phase: "unknown", stoppedAt: this.now(), reason } } : item), updatedAt: this.now() });
        await this.fileSets.interrupt(id, reason);
        return { kind: "blocked", blocker: { kind: "unknown_partial_mutation", operationId: jjOperationId(operationId), phase: "workspace_file_checkpoint" } };
      }
    });
  }

  private async boundary(id: WorkspaceId, operationId: string, boundary: "mutating" | "verifying"): Promise<void> { await this.workspaces.update(id, (record) => record.phase !== "active" ? record : { ...record, operations: record.operations.map((item) => item.operationId === operationId && item.outcome.phase === "started" ? { ...item, outcome: { phase: "started", boundary } } : item), updatedAt: this.now() }); }
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
