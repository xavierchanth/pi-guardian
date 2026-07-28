import { createHash } from "node:crypto";
import type { SharedFileSetCoordinator, FileSetBaselineVerifier } from "../concurrency/file-sets.ts";
import { jjOperationId } from "../concurrency/ids.ts";
import { changeId, type ChangeId, type CheckpointableFileSetClaim, type SourceWorkspaceHandle } from "./domain.ts";
import type { SharedSourceStore } from "./persistence.ts";
import type {
  CheckpointChangeReceipt,
  JjOperationBlocker,
  JjOperationResult,
  SharedChangeCheckpointer,
} from "./operations.ts";
import { exactChange, JjRepositoryKernel, literalRootFileset } from "./repository.ts";

export interface InterruptedCheckpointDisposition {
  readonly operationId: string;
  readonly claimId: string;
  readonly classification: "completed" | "safe_to_reissue" | "unknown";
  readonly receipt?: CheckpointChangeReceipt;
}

export class DeterministicSharedCheckpointer implements SharedChangeCheckpointer {
  private readonly kernel: JjRepositoryKernel;
  private readonly store: SharedSourceStore;
  private readonly fileSets: SharedFileSetCoordinator;

  constructor(options: {
    kernel: JjRepositoryKernel;
    store: SharedSourceStore;
    fileSets: SharedFileSetCoordinator;
  }) {
    this.kernel = options.kernel;
    this.store = options.store;
    this.fileSets = options.fileSets;
  }

  async checkpointChange(claim: CheckpointableFileSetClaim): Promise<JjOperationResult<CheckpointChangeReceipt>> {
    const active = await this.fileSets.requireActive(claim);
    return this.kernel.withRepositoryMutation(active.source, async () => {
      const refreshed = await this.fileSets.requireActive(claim);
      if (refreshed.record.phase !== "active") {
        return {
          kind: "blocked",
          blocker: {
            kind: "unknown_partial_mutation",
            operationId: jjOperationId(refreshed.record.operationId),
            phase: "checkpointing",
          },
        };
      }
      const sourceRecord = await this.store.get(active.source.sourceId);
      if (!sourceRecord) throw new Error(`Unknown shared source: ${active.source.sourceId}`);
      const targetBinding = sourceRecord.targets.find((target) => target.changeId === refreshed.record.targetChangeId);
      if (!targetBinding || targetBinding.ownerContextId !== refreshed.record.ownerContextId || targetBinding.baseChangeId !== refreshed.record.baseChangeId) {
        return {
          kind: "blocked",
          blocker: { kind: "foreign_work", reason: "Active file-set claim no longer matches its assigned target owner and base." },
        };
      }
      const workingId = await this.kernel.currentChangeId(active.source);
      const targetId = changeId(refreshed.record.targetChangeId);
      const [working, target] = await Promise.all([this.resolve(active.source, workingId), this.resolve(active.source, targetId)]);
      if (!working || !target) return { kind: "blocked", blocker: { kind: "identity_mismatch", expected: !working ? workingId : targetId, observed: [] } };
      if (working.immutable) return { kind: "blocked", blocker: { kind: "immutable", changeId: workingId } };
      if (target.immutable) return { kind: "blocked", blocker: { kind: "immutable", changeId: targetId } };
      if (working.conflicted || target.conflicted) return { kind: "blocked", blocker: { kind: "conflicted", changeIds: [workingId, targetId], paths: refreshed.record.paths } };
      const filesets = refreshed.record.paths.map(literalRootFileset);
      const changedPaths = await this.kernel.changedPaths(active.source, exactChange(workingId), filesets);
      if (!changedPaths.length) {
        return { kind: "blocked", blocker: { kind: "decision_required", reason: "Locked file set has no effective working-change content to checkpoint." } };
      }
      if (changedPaths.some((path) => !refreshed.record.paths.some((root) => covered(root, path)))) {
        return { kind: "blocked", blocker: { kind: "foreign_work", reason: "JJ selected a path outside the active file-set claim." } };
      }
      const unownedFileset = complementFileset(refreshed.record.paths);
      const beforeUnownedHash = hash(await this.kernel.patchEvidence(active.source, exactChange(workingId), [unownedFileset]));
      const operation = await this.kernel.startOperation(active.source, "checkpoint_change", `checkpoint:${claim.claimId}`);
      try {
        await this.fileSets.beginCheckpoint(claim, operation.operationId);
      } catch (error) {
        const blocker = { kind: "foreign_work", reason: error instanceof Error ? error.message : String(error) } as const;
        await this.kernel.blockOperation(active.source, operation.operationId, blocker);
        return { kind: "blocked", blocker };
      }
      try {
        await this.kernel.runMutation(active.source, [
          "squash",
          "--from",
          exactChange(workingId),
          "--into",
          exactChange(targetId),
          "--keep-emptied",
          ...filesets,
        ]);
      } catch (error) {
        return this.unknown(active.source, operation.operationId, error);
      }
      const [verifiedWorking, verifiedTarget, verifiedCurrent] = await Promise.all([
        this.resolve(active.source, workingId),
        this.resolve(active.source, targetId),
        this.kernel.currentChangeId(active.source),
      ]);
      if (!verifiedWorking || !verifiedTarget || verifiedCurrent !== workingId) {
        return this.unknown(active.source, operation.operationId, "Checkpoint identity verification failed after squash.");
      }
      const afterUnownedHash = hash(await this.kernel.patchEvidence(active.source, exactChange(workingId), [unownedFileset]));
      const remainingOwned = await this.kernel.changedPaths(active.source, exactChange(workingId), filesets);
      if (afterUnownedHash !== beforeUnownedHash || remainingOwned.length) {
        return this.unknown(active.source, operation.operationId, "Checkpoint did not preserve unrelated working-change evidence or fully extract the locked paths.");
      }
      if (verifiedWorking.conflicted || verifiedTarget.conflicted) {
        const blocker: JjOperationBlocker = {
          kind: "conflicted",
          changeIds: [verifiedTarget.changeId, verifiedWorking.changeId],
          paths: changedPaths,
        };
        await this.kernel.blockOperation(active.source, operation.operationId, blocker);
        return { kind: "blocked", blocker };
      }
      const targetPaths = await this.kernel.changedPaths(active.source, exactChange(targetId), filesets);
      if (changedPaths.some((path) => !targetPaths.includes(path))) {
        return this.unknown(active.source, operation.operationId, "Checkpoint target does not contain every moved path.");
      }
      const receipt: CheckpointChangeReceipt = {
        checkpointedChangeId: targetId,
        workingChangeId: workingId,
        claimId: claim.claimId,
        changedPaths,
        parentChangeIds: verifiedTarget.parentChangeIds,
        unownedWorkingPatchHash: afterUnownedHash,
        conflicted: false,
        operationId: jjOperationId(operation.operationId),
      };
      await this.kernel.completeOperation(active.source, operation.operationId, receipt);
      await this.fileSets.releaseAfterCheckpoint(claim, operation.operationId);
      return { kind: "completed", receipt };
    });
  }

  async reconcileInterrupted(source: SourceWorkspaceHandle): Promise<InterruptedCheckpointDisposition[]> {
    const sourceRecord = await this.store.get(source.sourceId);
    if (!sourceRecord) throw new Error(`Unknown shared source: ${source.sourceId}`);
    const dispositions: InterruptedCheckpointDisposition[] = [];
    for (const operation of sourceRecord.operations) {
      if (operation.phase !== "started" || operation.kind !== "checkpoint_change") continue;
      const claim = sourceRecord.claims.find((candidate) =>
        candidate.phase === "interrupted"
        && candidate.priorPhase === "checkpointing"
        && candidate.recovery?.operationId === operation.operationId,
      );
      if (!claim || claim.phase !== "interrupted" || !claim.recovery) continue;
      const currentJjOperationId = await this.kernel.operationIdFor(source);
      if (currentJjOperationId === operation.beforeJjOperationId) {
        dispositions.push({ operationId: operation.operationId, claimId: claim.claimId, classification: "safe_to_reissue" });
        continue;
      }
      const workingId = changeId(claim.workingChangeId);
      const targetId = changeId(claim.targetChangeId);
      const [working, target] = await Promise.all([this.resolve(source, workingId), this.resolve(source, targetId)]);
      const filesets = claim.paths.map(literalRootFileset);
      const [remainingWorking, targetPaths] = await Promise.all([
        this.kernel.changedPaths(source, exactChange(workingId), filesets).catch((): string[] => ["<unresolved>"]),
        this.kernel.changedPaths(source, exactChange(targetId), filesets).catch((): string[] => []),
      ]);
      const expectedPaths = claim.recovery.mutatedPaths;
      if (working && target && remainingWorking.length === 0 && expectedPaths.length > 0 && expectedPaths.every((path) => targetPaths.includes(path))) {
        const receipt: CheckpointChangeReceipt = {
          checkpointedChangeId: targetId,
          workingChangeId: workingId,
          claimId: claim.claimId,
          changedPaths: expectedPaths,
          parentChangeIds: target.parentChangeIds,
          unownedWorkingPatchHash: hash(await this.kernel.patchEvidence(source, exactChange(workingId), [complementFileset(claim.paths)])),
          conflicted: working.conflicted || target.conflicted,
          operationId: jjOperationId(operation.operationId),
        };
        await this.kernel.completeOperation(source, operation.operationId, receipt);
        await this.fileSets.settleInterruptedCheckpoint(source, claim.claimId, operation.operationId);
        dispositions.push({ operationId: operation.operationId, claimId: claim.claimId, classification: "completed", receipt });
        continue;
      }
      await this.kernel.unknownOperation(source, operation.operationId, "Interrupted checkpoint postconditions are neither unchanged nor independently complete.");
      dispositions.push({ operationId: operation.operationId, claimId: claim.claimId, classification: "unknown" });
    }
    return dispositions;
  }

  private async resolve(source: SourceWorkspaceHandle, id: ChangeId) {
    try {
      return await this.kernel.resolveChange(source, id);
    } catch {
      return undefined;
    }
  }

  private async unknown(
    source: SourceWorkspaceHandle,
    operationId: string,
    error: unknown,
  ): Promise<JjOperationResult<CheckpointChangeReceipt>> {
    await this.kernel.unknownOperation(source, operationId, error instanceof Error ? error.message : String(error));
    return {
      kind: "blocked",
      blocker: { kind: "unknown_partial_mutation", operationId: jjOperationId(operationId), phase: "checkpoint_change" },
    };
  }
}

export function createJjBaselineVerifier(kernel: JjRepositoryKernel): FileSetBaselineVerifier {
  return async (source, paths) => {
    const filesets = paths.map(literalRootFileset);
    const workingChangeId = await kernel.currentChangeId(source);
    const patch = await kernel.patchEvidence(source, exactChange(workingChangeId), filesets);
    return {
      workingChangeId,
      patchHash: hash(patch),
      changedPaths: await kernel.changedPaths(source, exactChange(workingChangeId), filesets),
    };
  };
}

export function complementFileset(paths: readonly string[]): string {
  if (!paths.length) throw new Error("Cannot construct a complement for an empty file set.");
  return `~(${paths.map(literalRootFileset).join(" | ")})`;
}

function covered(root: string, path: string): boolean { return root === path || path.startsWith(`${root}/`); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
