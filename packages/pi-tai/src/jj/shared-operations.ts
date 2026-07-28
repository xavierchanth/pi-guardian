import { createHash } from "node:crypto";
import { type ChangeDescription, changeId, type SourceWorkspaceHandle } from "./domain.ts";
import {
  type ChangeInserter,
  type InsertChangeReceipt,
  type JjOperationBlocker,
  type JjOperationResult,
  type JjStatus,
  type JjStatusReader,
} from "./operations.ts";
import type { PersistedSharedTargetV1, SharedSourceStore } from "./persistence.ts";
import { exactChange, JjCommandError, JjRepositoryKernel } from "./repository.ts";
import { childContextId, jjOperationId } from "../concurrency/ids.ts";

export class SharedJjOperations implements JjStatusReader, ChangeInserter {
  private readonly kernel: JjRepositoryKernel;
  private readonly store: SharedSourceStore;
  private readonly now: () => string;

  constructor(options: { kernel: JjRepositoryKernel; store: SharedSourceStore; now?: () => string }) {
    this.kernel = options.kernel;
    this.store = options.store;
    this.now = options.now ?? (() => new Date().toISOString());
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
    };
  }

  insertChange(
    source: SourceWorkspaceHandle,
    input: Readonly<{ description: ChangeDescription; owner: ReturnType<typeof childContextId> }>,
  ): Promise<JjOperationResult<InsertChangeReceipt>> {
    return this.kernel.withRepositoryMutation(source, async () => {
      const inspected = await this.kernel.inspect(source);
      const working = inspected.current;
      const operation = await this.kernel.startOperation(
        source,
        "insert_change",
        `insert:${working.changeId}:${input.owner}:${hash(input.description)}`,
      );
      const operationId = jjOperationId(operation.operationId);
      if (working.parentChangeIds.length !== 1) {
        return this.block(source, operation.operationId, {
          kind: "decision_required",
          reason: "Current source @ must have exactly one parent before inserting a shared target.",
        });
      }
      if (working.immutable) return this.block(source, operation.operationId, { kind: "immutable", changeId: working.changeId });
      if (working.conflicted) return this.block(source, operation.operationId, { kind: "conflicted", changeIds: [working.changeId], paths: [] });
      const baseChangeId = working.parentChangeIds[0]!;
      const beforeHash = hash(await this.kernel.patchEvidence(source, exactChange(working.changeId)));
      try {
        await this.kernel.runMutation(source, [
          "new", "--no-edit", "--insert-before", exactChange(working.changeId), "--message", input.description,
        ]);
      } catch (error) {
        return this.unknown(source, operation.operationId, error);
      }
      const verifiedWorking = await this.tryResolve(source, working.changeId, operation.operationId);
      if (isBlocked(verifiedWorking)) return verifiedWorking;
      const current = await this.kernel.currentChangeId(source);
      const afterHash = hash(await this.kernel.patchEvidence(source, exactChange(working.changeId)));
      if (current !== working.changeId || afterHash !== beforeHash) {
        return this.unknown(source, operation.operationId, "Inserted target did not preserve source working-change identity and content evidence.");
      }
      if (verifiedWorking.parentChangeIds.length !== 1) {
        return this.unknown(source, operation.operationId, "Inserted target did not become the unique immediate working-change parent.");
      }
      const insertedId = verifiedWorking.parentChangeIds[0]!;
      if (insertedId === baseChangeId) {
        return this.unknown(source, operation.operationId, "Working-change parent did not change to a new inserted Change ID.");
      }
      const inserted = await this.tryResolve(source, insertedId, operation.operationId);
      if (isBlocked(inserted)) return inserted;
      if (!inserted.empty || inserted.description !== input.description || inserted.parentChangeIds.length !== 1 || inserted.parentChangeIds[0] !== baseChangeId) {
        return this.unknown(source, operation.operationId, "Inserted target topology, emptiness, or description verification failed.");
      }
      const receipt: InsertChangeReceipt = {
        insertedChangeId: inserted.changeId,
        baseChangeId: changeId(baseChangeId),
        workingChangeId: working.changeId,
        owner: input.owner,
        description: input.description,
        parentChangeIds: inserted.parentChangeIds,
        workingParentChangeIds: verifiedWorking.parentChangeIds,
        workingPatchHash: afterHash,
        operationId,
      };
      const target: PersistedSharedTargetV1 = {
        changeId: inserted.changeId,
        baseChangeId,
        workingChangeId: working.changeId,
        ownerContextId: input.owner,
        description: input.description,
        insertOperationId: operation.operationId,
        createdAt: this.now(),
      };
      await this.store.update(source.sourceId, (record) => ({ ...record, targets: [...record.targets, target], updatedAt: target.createdAt }));
      await this.kernel.completeOperation(source, operation.operationId, receipt);
      return { kind: "completed", receipt };
    });
  }

  private async tryResolve(source: SourceWorkspaceHandle, id: ReturnType<typeof changeId>, operationId: string) {
    try { return await this.kernel.resolveChange(source, id); }
    catch {
      const blocker: JjOperationBlocker = { kind: "identity_mismatch", expected: id, observed: [] };
      await this.kernel.blockOperation(source, operationId, blocker);
      return { kind: "blocked", blocker } as const;
    }
  }
  private async block<Receipt>(source: SourceWorkspaceHandle, operationId: string, blocker: JjOperationBlocker): Promise<JjOperationResult<Receipt>> { await this.kernel.blockOperation(source, operationId, blocker); return { kind: "blocked", blocker }; }
  private async unknown<Receipt>(source: SourceWorkspaceHandle, operationId: string, error: unknown): Promise<JjOperationResult<Receipt>> {
    await this.kernel.unknownOperation(source, operationId, error instanceof Error ? error.message : String(error));
    return { kind: "blocked", blocker: { kind: "unknown_partial_mutation", operationId: jjOperationId(operationId), phase: error instanceof JjCommandError ? "jj_command" : "verification" } };
  }
}
function isBlocked<T>(value: T | { kind: "blocked"; blocker: JjOperationBlocker }): value is { kind: "blocked"; blocker: JjOperationBlocker } { return typeof value === "object" && value !== null && "kind" in value && value.kind === "blocked"; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
