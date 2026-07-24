import { createHash } from "node:crypto";
import { changeDescription, changeId, type ChangeDescription, type SourceWorkspaceHandle } from "./domain.ts";
import {
  type EnsureWipReceipt,
  type InsertChangeReceipt,
  type JjOperationBlocker,
  type JjOperationResult,
  type JjStatus,
  type JjStatusReader,
  type WipEnsurer,
  type ChangeInserter,
} from "./operations.ts";
import type { PersistedSharedTargetV1, SharedSourceStore } from "./persistence.ts";
import { exactChange, JjCommandError, JjRepositoryKernel } from "./repository.ts";
import { childContextId, jjOperationId } from "../concurrency/ids.ts";

export const DEFAULT_WIP_DESCRIPTION = "wip: thinker workspace";

export class SharedJjOperations implements JjStatusReader, WipEnsurer, ChangeInserter {
  private readonly kernel: JjRepositoryKernel;
  private readonly store: SharedSourceStore;
  private readonly now: () => string;
  private readonly wipDescription: ChangeDescription;

  constructor(options: {
    kernel: JjRepositoryKernel;
    store: SharedSourceStore;
    now?: () => string;
    wipDescription?: string;
  }) {
    this.kernel = options.kernel;
    this.store = options.store;
    this.now = options.now ?? (() => new Date().toISOString());
    this.wipDescription = changeDescription(options.wipDescription ?? DEFAULT_WIP_DESCRIPTION);
  }

  async inspectStatus(source: SourceWorkspaceHandle): Promise<JjStatus> {
    const inspected = await this.kernel.inspect(source);
    return {
      sourceChangeId: inspected.current.changeId,
      operationId: jjOperationId(inspected.jjOperationId),
      description: inspected.current.description,
      empty: inspected.current.empty,
      conflicted: inspected.current.conflicted,
      immutable: inspected.current.immutable,
      parentChangeIds: inspected.current.parentChangeIds,
      ...(inspected.source.wip ? { trackedWipChangeId: changeId(inspected.source.wip.changeId) } : {}),
      privateProtection: hasPrivateProtection(inspected.privateCommitSelector) ? "present" : "missing",
    };
  }

  ensureWip(source: SourceWorkspaceHandle): Promise<JjOperationResult<EnsureWipReceipt>> {
    return this.kernel.withRepositoryMutation(source, async () => {
      const inspected = await this.kernel.inspect(source);
      const operation = await this.kernel.startOperation(source, "ensure_wip", `ensure:${inspected.current.changeId}`);
      const operationId = jjOperationId(operation.operationId);
      const protection = hasPrivateProtection(inspected.privateCommitSelector) ? "present" : "missing";
      const tracked = inspected.source.wip;
      if (tracked) {
        const exact = await this.tryResolve(source, changeId(tracked.changeId), operation.operationId);
        if (isBlocked(exact)) return exact;
        if (exact.changeId !== inspected.current.changeId) {
          return this.block(source, operation.operationId, {
            kind: "identity_mismatch",
            expected: exact.changeId,
            observed: [inspected.current.changeId],
          });
        }
        if (exact.immutable) return this.block(source, operation.operationId, { kind: "immutable", changeId: exact.changeId });
        const receipt: EnsureWipReceipt = {
          wipChangeId: exact.changeId,
          operationId,
          disposition: "existing",
          description: changeDescription(exact.description),
          privateProtection: protection,
        };
        await this.kernel.completeOperation(source, operation.operationId, receipt);
        return { kind: "completed", receipt };
      }
      if (inspected.current.immutable) {
        return this.block(source, operation.operationId, { kind: "immutable", changeId: inspected.current.changeId });
      }
      if (!inspected.current.empty) {
        return this.block(source, operation.operationId, {
          kind: "decision_required",
          reason: "Current @ contains unknown nonempty work and cannot be relabeled as Pi-Tai WIP automatically.",
        });
      }
      if (inspected.current.conflicted) {
        return this.block(source, operation.operationId, {
          kind: "conflicted",
          changeIds: [inspected.current.changeId],
          paths: [],
        });
      }
      const alreadyCanonical = isWipDescription(inspected.current.description);
      if (!alreadyCanonical) {
        try {
          await this.kernel.runMutation(source, [
            "describe", "--message", this.wipDescription, exactChange(inspected.current.changeId),
          ]);
        } catch (error) {
          return this.unknown(source, operation.operationId, error);
        }
      }
      const verified = await this.tryResolve(source, inspected.current.changeId, operation.operationId);
      if (isBlocked(verified)) return verified;
      if (verified.changeId !== await this.kernel.currentChangeId(source) || (!alreadyCanonical && verified.description !== this.wipDescription)) {
        return this.unknown(source, operation.operationId, "WIP describe completed without the required identity and description postconditions.");
      }
      const receipt: EnsureWipReceipt = {
        wipChangeId: verified.changeId,
        operationId,
        disposition: alreadyCanonical ? "existing" : "described_existing",
        description: changeDescription(verified.description),
        privateProtection: protection,
      };
      const at = this.now();
      await this.store.update(source.sourceId, (record) => ({
        ...record,
        wip: {
          changeId: verified.changeId,
          description: receipt.description,
          ensuredOperationId: operation.operationId,
        },
        updatedAt: at,
      }));
      await this.kernel.completeOperation(source, operation.operationId, receipt);
      return { kind: "completed", receipt };
    });
  }

  insertChange(
    source: SourceWorkspaceHandle,
    input: Readonly<{ description: ChangeDescription; owner: ReturnType<typeof childContextId> }>,
  ): Promise<JjOperationResult<InsertChangeReceipt>> {
    return this.kernel.withRepositoryMutation(source, async () => {
      const inspected = await this.kernel.inspect(source);
      const tracked = inspected.source.wip;
      const operation = await this.kernel.startOperation(
        source,
        "insert_change",
        `insert:${tracked?.changeId ?? "missing"}:${input.owner}:${hash(input.description)}`,
      );
      const operationId = jjOperationId(operation.operationId);
      if (!tracked) {
        return this.block(source, operation.operationId, {
          kind: "decision_required",
          reason: "Run ensure_wip_change before inserting a shared target.",
        });
      }
      const wip = await this.tryResolve(source, changeId(tracked.changeId), operation.operationId);
      if (isBlocked(wip)) return wip;
      if (wip.changeId !== inspected.current.changeId) {
        return this.block(source, operation.operationId, {
          kind: "identity_mismatch",
          expected: wip.changeId,
          observed: [inspected.current.changeId],
        });
      }
      if (wip.immutable) return this.block(source, operation.operationId, { kind: "immutable", changeId: wip.changeId });
      if (wip.conflicted) return this.block(source, operation.operationId, { kind: "conflicted", changeIds: [wip.changeId], paths: [] });
      const beforeEvidence = await this.kernel.patchEvidence(source, exactChange(wip.changeId));
      const beforeHash = hash(beforeEvidence);
      const priorParents = wip.parentChangeIds;
      try {
        await this.kernel.runMutation(source, [
          "new",
          "--no-edit",
          "--insert-before",
          exactChange(wip.changeId),
          "--message",
          input.description,
        ]);
      } catch (error) {
        return this.unknown(source, operation.operationId, error);
      }
      const verifiedWip = await this.tryResolve(source, wip.changeId, operation.operationId);
      if (isBlocked(verifiedWip)) return verifiedWip;
      const current = await this.kernel.currentChangeId(source);
      const afterHash = hash(await this.kernel.patchEvidence(source, exactChange(wip.changeId)));
      if (current !== wip.changeId || afterHash !== beforeHash) {
        return this.unknown(source, operation.operationId, "Inserted target did not preserve source WIP identity and content evidence.");
      }
      if (verifiedWip.parentChangeIds.length !== 1) {
        return this.unknown(source, operation.operationId, "Inserted target did not become the unique immediate WIP parent.");
      }
      const insertedId = verifiedWip.parentChangeIds[0]!;
      if (priorParents.includes(insertedId)) {
        return this.unknown(source, operation.operationId, "WIP parent did not change to a new inserted Change ID.");
      }
      const inserted = await this.tryResolve(source, insertedId, operation.operationId);
      if (isBlocked(inserted)) return inserted;
      if (!inserted.empty || inserted.description !== input.description || !sameIds(inserted.parentChangeIds, priorParents)) {
        return this.unknown(source, operation.operationId, "Inserted target topology, emptiness, or description verification failed.");
      }
      const receipt: InsertChangeReceipt = {
        insertedChangeId: inserted.changeId,
        wipChangeId: wip.changeId,
        owner: input.owner,
        description: input.description,
        parentChangeIds: inserted.parentChangeIds,
        priorWipParentChangeIds: priorParents,
        wipParentChangeIds: verifiedWip.parentChangeIds,
        wipPatchHash: afterHash,
        operationId,
      };
      const target: PersistedSharedTargetV1 = {
        changeId: inserted.changeId,
        wipChangeId: wip.changeId,
        ownerContextId: input.owner,
        description: input.description,
        insertOperationId: operation.operationId,
        createdAt: this.now(),
      };
      await this.store.update(source.sourceId, (record) => ({
        ...record,
        targets: [...record.targets, target],
        updatedAt: target.createdAt,
      }));
      await this.kernel.completeOperation(source, operation.operationId, receipt);
      return { kind: "completed", receipt };
    });
  }

  private async tryResolve(source: SourceWorkspaceHandle, id: ReturnType<typeof changeId>, operationId: string) {
    try {
      return await this.kernel.resolveChange(source, id);
    } catch (error) {
      const blocker: JjOperationBlocker = {
        kind: "identity_mismatch",
        expected: id,
        observed: [],
      };
      await this.kernel.blockOperation(source, operationId, blocker);
      return { kind: "blocked", blocker } as const;
    }
  }

  private async block<Receipt>(source: SourceWorkspaceHandle, operationId: string, blocker: JjOperationBlocker): Promise<JjOperationResult<Receipt>> {
    await this.kernel.blockOperation(source, operationId, blocker);
    return { kind: "blocked", blocker };
  }

  private async unknown<Receipt>(source: SourceWorkspaceHandle, operationId: string, error: unknown): Promise<JjOperationResult<Receipt>> {
    const reason = error instanceof Error ? error.message : String(error);
    await this.kernel.unknownOperation(source, operationId, reason);
    return {
      kind: "blocked",
      blocker: { kind: "unknown_partial_mutation", operationId: jjOperationId(operationId), phase: error instanceof JjCommandError ? "jj_command" : "verification" },
    };
  }
}

function isBlocked<T>(value: T | { kind: "blocked"; blocker: JjOperationBlocker }): value is { kind: "blocked"; blocker: JjOperationBlocker } {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "blocked";
}
function hasPrivateProtection(selector: string | undefined): boolean {
  return selector !== undefined && /description\(['"](?:wip|private):/.test(selector);
}
function isWipDescription(description: string): boolean { return /^(?:wip|private):/.test(description.trim()); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
