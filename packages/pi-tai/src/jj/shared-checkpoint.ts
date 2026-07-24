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
      if (!targetBinding || targetBinding.ownerContextId !== refreshed.record.ownerContextId || targetBinding.wipChangeId !== refreshed.record.wipChangeId) {
        return {
          kind: "blocked",
          blocker: { kind: "foreign_work", reason: "Active file-set claim no longer matches its assigned target owner and WIP." },
        };
      }
      const wipId = changeId(refreshed.record.wipChangeId);
      const targetId = changeId(refreshed.record.targetChangeId);
      const [wip, target, current] = await Promise.all([
        this.resolve(active.source, wipId),
        this.resolve(active.source, targetId),
        this.kernel.currentChangeId(active.source),
      ]);
      if (!wip || !target) {
        return { kind: "blocked", blocker: { kind: "identity_mismatch", expected: !wip ? wipId : targetId, observed: [] } };
      }
      if (current !== wipId) {
        return { kind: "blocked", blocker: { kind: "identity_mismatch", expected: wipId, observed: [current] } };
      }
      if (wip.immutable) return { kind: "blocked", blocker: { kind: "immutable", changeId: wipId } };
      if (target.immutable) return { kind: "blocked", blocker: { kind: "immutable", changeId: targetId } };
      if (wip.conflicted || target.conflicted) {
        return { kind: "blocked", blocker: { kind: "conflicted", changeIds: [wipId, targetId], paths: refreshed.record.paths } };
      }
      const filesets = refreshed.record.paths.map(literalRootFileset);
      const changedPaths = await this.kernel.changedPaths(active.source, exactChange(wipId), filesets);
      if (!changedPaths.length) {
        return { kind: "blocked", blocker: { kind: "decision_required", reason: "Locked file set has no effective WIP changes to checkpoint." } };
      }
      if (changedPaths.some((path) => !refreshed.record.paths.some((root) => covered(root, path)))) {
        return { kind: "blocked", blocker: { kind: "foreign_work", reason: "JJ selected a path outside the active file-set claim." } };
      }
      const unownedFileset = complementFileset(refreshed.record.paths);
      const beforeUnownedHash = hash(await this.kernel.patchEvidence(active.source, exactChange(wipId), [unownedFileset]));
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
          exactChange(wipId),
          "--into",
          exactChange(targetId),
          "--keep-emptied",
          ...filesets,
        ]);
      } catch (error) {
        return this.unknown(active.source, operation.operationId, error);
      }
      const [verifiedWip, verifiedTarget, verifiedCurrent] = await Promise.all([
        this.resolve(active.source, wipId),
        this.resolve(active.source, targetId),
        this.kernel.currentChangeId(active.source),
      ]);
      if (!verifiedWip || !verifiedTarget || verifiedCurrent !== wipId) {
        return this.unknown(active.source, operation.operationId, "Checkpoint identity verification failed after squash.");
      }
      const afterUnownedHash = hash(await this.kernel.patchEvidence(active.source, exactChange(wipId), [unownedFileset]));
      const remainingOwned = await this.kernel.changedPaths(active.source, exactChange(wipId), filesets);
      if (afterUnownedHash !== beforeUnownedHash || remainingOwned.length) {
        return this.unknown(active.source, operation.operationId, "Checkpoint did not preserve unrelated WIP evidence or fully extract the locked paths.");
      }
      if (verifiedWip.conflicted || verifiedTarget.conflicted) {
        const blocker: JjOperationBlocker = {
          kind: "conflicted",
          changeIds: [verifiedTarget.changeId, verifiedWip.changeId],
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
        wipChangeId: wipId,
        claimId: claim.claimId,
        changedPaths,
        parentChangeIds: verifiedTarget.parentChangeIds,
        unownedWipPatchHash: afterUnownedHash,
        conflicted: false,
        operationId: jjOperationId(operation.operationId),
      };
      await this.kernel.completeOperation(active.source, operation.operationId, receipt);
      await this.fileSets.releaseAfterCheckpoint(claim, operation.operationId);
      return { kind: "completed", receipt };
    });
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
  return async (source, wipChangeId, paths) => {
    const filesets = paths.map(literalRootFileset);
    const patch = await kernel.patchEvidence(source, exactChange(changeId(wipChangeId)), filesets);
    return {
      patchHash: hash(patch),
      changedPaths: await kernel.changedPaths(source, exactChange(changeId(wipChangeId)), filesets),
    };
  };
}

export function complementFileset(paths: readonly string[]): string {
  if (!paths.length) throw new Error("Cannot construct a complement for an empty file set.");
  return `~(${paths.map(literalRootFileset).join(" | ")})`;
}

function covered(root: string, path: string): boolean { return root === path || path.startsWith(`${root}/`); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
