import { createHash } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { type ProcessState, processState, withOperationLease } from "../storage/operation-lease.ts";
import type { CustodyRecord, WorkspaceCustodyPort } from "./custody-port.ts";
import type { MergeClassification, MergePhaseReceipt, MergeSummary } from "./domain.ts";
import { exact, JjCli } from "./jj.ts";

export type CustodySagaKind = "create" | "merge" | "finalize_merge" | "forget" | "abandon";
export type CustodyCrashBoundary = "after_intent" | "after_jj" | "after_receipt" | "after_commit";
export interface CustodySagaRequest {
  kind: CustodySagaKind;
  workspaceId: string;
  repoId: string;
  repoRoot: string;
  rootSessionId: string;
  requestedBy: "user" | "model_tool" | "system_spawn" | "system_settle" | "scaffold_reclaim";
  /** Required for create. */ record?: CustodyRecord;
  /** Exact destination Change ID for merge/finalize_merge. */ targetChangeId?: string;
  /** Durable destination checkout, including a parent managed workspace. */ targetPath?: string;
  /** Ordered content changes reported by the public merge result. */ mergeChangeIds?: readonly string[];
  /** Coordinator-written receipt; callers must never supply or predict it. */ actualMerge?: MergeSummary;
  /** Durable in-progress evidence; callers must never supply or predict it. */
  receipt?: MergeExecutionReceipt;
}

interface MergeExecutionReceipt {
  classification: MergeClassification;
  phaseA: MergePhaseReceipt;
  phaseB: MergePhaseReceipt;
}

/** Stable across retries, including retries in another process. */
export function custodyOperationId(request: CustodySagaRequest): string {
  const semantic = {
    v: 1,
    kind: request.kind,
    workspaceId: request.workspaceId,
    repoId: request.repoId,
    targetChangeId: request.targetChangeId ?? null,
    heads: request.record ? [...new Set(request.record.headChangeIds)].sort() : null,
  };
  return `cop_${createHash("sha256").update(JSON.stringify(semantic)).digest("hex").slice(0, 40)}`;
}

/**
 * K6 coordinator. It is intentionally not constructed by WorkspaceManager.
 * SQLite is the authority and paths are only JJ locations: repository identity
 * and every mutation are checked against the durable repo/root-session ids.
 */
export class SQLiteCustodyCoordinator {
  private readonly db: DatabaseSync;
  private readonly port: WorkspaceCustodyPort;
  private readonly jj: JjCli;
  private readonly processIdentity: string;
  private readonly now: () => string;
  private readonly fault?: (boundary: CustodyCrashBoundary, opId: string) => void;
  private readonly processState: (pid: number) => ProcessState;
  constructor(
    db: DatabaseSync,
    port: WorkspaceCustodyPort,
    jj: JjCli,
    processIdentity = `${process.pid}:custody`,
    now = () => new Date().toISOString(),
    fault?: (boundary: CustodyCrashBoundary, opId: string) => void,
    processStateProbe: (pid: number) => ProcessState = processState,
  ) {
    this.db = db;
    this.port = port;
    this.jj = jj;
    this.processIdentity = processIdentity;
    this.now = now;
    this.fault = fault;
    this.processState = processStateProbe;
  }

  async run(request: CustodySagaRequest): Promise<CustodyRecord> {
    const opId = custodyOperationId(request);
    const existing = this.operation(opId);
    if (existing?.state === "committed") {
      const row = await this.port.get(request.workspaceId);
      if (!row) throw new Error("Committed custody operation has no row");
      return row;
    }
    if (existing?.state === "failed")
      throw new Error(`Custody operation previously refused: ${String(existing.evidence)}`);
    if (!existing) {
      if (
        request.kind === "abandon" &&
        !["user", "model_tool", "scaffold_reclaim"].includes(request.requestedBy)
      )
        throw new Error("Destructive abandon requires an explicit actor");
      const row =
        request.kind === "create" ? request.record : await this.port.get(request.workspaceId);
      if (!row) throw new Error("Unknown custody workspace");
      if (row.repoId !== request.repoId || row.rootSessionId !== request.rootSessionId)
        throw new Error("Custody operation refused: cross-root authority");
      const heads = [...new Set(row.headChangeIds)].sort();
      try {
        await this.port.begin({
          opId,
          workspaceId: request.workspaceId,
          repoId: request.repoId,
          kind: request.kind,
          requestedBy: request.requestedBy,
          pid: process.pid,
          processIdentity: this.processIdentity,
          changeIds: heads,
          now: this.now(),
        });
        this.db
          .prepare("UPDATE custody_operation SET target_change_id=?,evidence=? WHERE op_id=?")
          .run(request.targetChangeId ?? null, JSON.stringify(request), opId);
      } catch (error) {
        // A semantic duplicate may win the primary-key race. Any other failure
        // remains visible rather than being mistaken for successful leasing.
        if (!this.operation(opId)) throw error;
      }
      // Keep the injected crash outside duplicate-intent handling: a fault is
      // not a primary-key race and must stop this process at the boundary.
      this.fault?.("after_intent", opId);
    }
    return this.leased(request.repoId, () => this.resume(opId));
  }

  /** Forward-only scanner; safe to invoke at startup/test hooks concurrently. */
  async recover(repoId?: string): Promise<{ recovered: string[]; failed: string[] }> {
    const ops = await this.port.openOperations(repoId ? { repoId } : undefined);
    const recovered: string[] = [],
      failed: string[] = [];
    for (const op of ops) {
      try {
        await this.leased(String(op.repoId), () => this.resume(op.opId));
        recovered.push(op.opId);
      } catch (error) {
        // Settle this failure without preventing examination of later intents.
        const now = this.now();
        this.db
          .prepare(
            "UPDATE custody_operation SET state='unknown',settled_at=?,heartbeat_at=?,evidence=? WHERE op_id=? AND state<>'committed'",
          )
          .run(now, now, String(error).slice(0, 8192), op.opId);
        failed.push(op.opId);
      }
    }
    return { recovered, failed };
  }

  private leased<T>(repoId: string, operation: () => Promise<T>): Promise<T> {
    // As with migration, acquiring a free lease needs no proof of self. The
    // sentinel can own/renew that lease, while takeover still probes the prior
    // owner and remains fail-closed on unknown liveness.
    const self = this.processState(process.pid);
    const pidStart = self.state === "live" ? self.start : "unprovable";
    return withOperationLease(
      this.db,
      {
        scope: `custody:${repoId}`,
        owner: this.processIdentity,
        pidStart,
        waitMs: 30_000,
        processState: this.processState,
      },
      operation,
    );
  }

  private operation(opId: string): CustodyOperationRow | undefined {
    return this.db.prepare("SELECT * FROM custody_operation WHERE op_id=?").get(opId) as
      | CustodyOperationRow
      | undefined;
  }

  private async resume(opId: string): Promise<CustodyRecord> {
    let op = this.operation(opId);
    if (!op) throw new Error("Missing custody intent");
    if (op.state === "committed") return (await this.port.get(String(op.workspace_id)))!;
    const request = JSON.parse(String(op.evidence)) as CustodySagaRequest;
    let row = request.record ?? (await this.port.get(request.workspaceId));
    if (!row) throw new Error("Missing custody row");
    if (row.repoId !== request.repoId || row.rootSessionId !== request.rootSessionId)
      throw new Error("Custody recovery refused: cross-root authority");
    const heads = JSON.parse(String(op.change_ids ?? "[]")) as string[];

    if (op.state === "intent" || op.state === "unknown") {
      const before = await this.jj.currentOperationId(request.repoRoot);
      if (request.kind === "create") {
        const attached = await this.jj.workspaceHead(request.repoRoot, row.name);
        if (!attached)
          await this.jj.workspaceAdd(request.repoRoot, row.path, row.name, row.baseChangeIds);
      } else if (request.kind === "forget") {
        await this.updateSourceStale(row, "custody forget");
        await this.jj.workspaceForget(request.repoRoot, row.name);
      } else if (request.kind === "merge" || request.kind === "finalize_merge") {
        if (!request.targetChangeId || !heads.length)
          throw new Error("Merge needs exact heads and target");
        const targetPath = request.targetPath ?? request.repoRoot;
        const target = await this.jj.resolveChange(request.repoRoot, request.targetChangeId);
        if (target.kind !== "unique") throw new Error(`Merge target is ${target.kind}`);
        if ((await this.jj.changeIdAt(targetPath, "@")) !== request.targetChangeId)
          throw new Error("Merge target moved; exact target is not this working copy");
        const alreadyAncestor = await this.jj.areAncestorsOf(
          targetPath,
          heads,
          request.targetChangeId,
        );
        if (request.kind === "finalize_merge") {
          // Conflict retry is finalization only. It must never repeat the graph rewrite.
          if (!alreadyAncestor || !row.conflictRetained || !row.merge)
            throw new Error("Conflict finalization lacks durable merge ancestry receipt");
          await this.updateSourceStale(row, "custody conflict finalization");
          const retained = row.merge.classification;
          if (!retained) throw new Error("Retained merge classification is missing");
          const currentSource = await this.jj.workspaceHead(request.repoRoot, row.name);
          if (currentSource !== retained.sourceAt)
            throw new Error("merge_source_changed_after_conflict_receipt");
          // Finalization validates the persisted partition; resolving conflicts
          // legitimately changes classification predicates, so recomputing the
          // source-difference partition would reject honest retries.
          for (const id of retained.sourceContent ?? []) {
            if ((await this.jj.resolveChange(request.repoRoot, id)).kind !== "unique")
              throw new Error(`Persisted merge content is not unique: ${id}`);
            if (!(await this.jj.areAncestorsOf(targetPath, [id], request.targetChangeId)))
              throw new Error(`Persisted merge content lost ancestry: ${id}`);
          }
          request.actualMerge = row.merge;
        } else {
          if (alreadyAncestor) throw new Error("Fresh merge source is already in target ancestry");
          await this.updateSourceStale(row, "custody merge source");
          let classification =
            request.receipt?.classification ??
            (await this.jj.classifyMergeSource(
              request.repoRoot,
              row.name,
              request.targetChangeId,
              heads,
            ));
          // Ratified MG-0 policy: first ask JJ to remove genuinely redundant
          // merge edges. Only the exact empty merge commits are eligible.
          if (!request.receipt) {
            for (const id of classification.emptyMerges)
              await this.jj.simplifyParents(request.repoRoot, id);
            if (classification.emptyMerges.length)
              classification = await this.jj.classifyMergeSource(
                request.repoRoot,
                row.name,
                request.targetChangeId,
                heads,
              );
          }
          if (classification.emptyMerges.length || classification.exceptional.length) {
            const retainedReceipt = {
              name: "merge_source_empty_revision_retained",
              emptyMerges: classification.emptyMerges,
              exceptional: classification.exceptional,
            };
            this.db
              .prepare("UPDATE custody_operation SET evidence=? WHERE op_id=?")
              .run(JSON.stringify({ ...request, retainedReceipt }), opId);
            throw new Error(
              `merge_source_empty_revision_retained: ${JSON.stringify(retainedReceipt)}`,
            );
          }
          const receipt: MergeExecutionReceipt = request.receipt ?? {
            classification,
            phaseA: { abandoned: [] },
            phaseB: { abandoned: [] },
          };
          request.receipt = receipt;
          if (classification.linearInterior.length) {
            const prePhaseA =
              receipt.phaseA.preOperation ?? (await this.jj.currentOperationId(request.repoRoot));
            // Persist the complete partition and exact pre-operation boundary
            // before the first abandon. Recovery must never infer this evidence
            // from a graph it has already changed.
            receipt.phaseA = { ...receipt.phaseA, preOperation: prePhaseA };
            this.db
              .prepare("UPDATE custody_operation SET evidence=? WHERE op_id=?")
              .run(JSON.stringify(request), opId);
            this.db
              .prepare("UPDATE workspace SET merge_json=?,updated_at=? WHERE id=?")
              .run(
                JSON.stringify({ classification, phaseA: receipt.phaseA, phaseB: receipt.phaseB }),
                this.now(),
                row.id,
              );
            const phaseAVisibilities = await Promise.all(
              classification.linearInterior.map((id) =>
                this.jj.resolveChange(request.repoRoot, id),
              ),
            );
            const allHidden = phaseAVisibilities.every(
              (visibility) => visibility.kind === "hidden",
            );
            const allUnique = phaseAVisibilities.every(
              (visibility) => visibility.kind === "unique",
            );
            if (!allHidden && !allUnique)
              throw new Error("Phase A recovery found mixed or ambiguous visibility");
            const phaseAOp = allHidden
              ? await this.jj.currentOperationId(request.repoRoot)
              : await this.jj.abandonExactSet(request.repoRoot, classification.linearInterior);
            receipt.phaseA = {
              abandoned: classification.linearInterior,
              preOperation: prePhaseA,
              operation: phaseAOp,
            };
            this.db
              .prepare("UPDATE custody_operation SET evidence=? WHERE op_id=?")
              .run(JSON.stringify(request), opId);
            try {
              for (const id of classification.linearInterior)
                if ((await this.jj.resolveChange(request.repoRoot, id)).kind !== "hidden")
                  throw new Error(`Phase A id remains visible: ${id}`);
              for (const id of classification.sourceContent)
                if ((await this.jj.resolveChange(request.repoRoot, id)).kind !== "unique")
                  throw new Error(`Phase A content missing: ${id}`);
              if (!(await this.jj.workspaceHead(request.repoRoot, row.name)))
                throw new Error("Phase A detached source attachment");
              if (
                await this.jj.hasConflicts(
                  request.repoRoot,
                  classification.sourceContent.map(exact).join(" | "),
                )
              )
                throw new Error("Phase A introduced conflicts");
            } catch (proofError) {
              try {
                if ((await this.jj.currentOperationId(request.repoRoot)) !== phaseAOp)
                  throw new Error("foreign operation intervened");
                await this.jj.restoreOperation(request.repoRoot, prePhaseA);
                for (const id of classification.linearInterior)
                  if ((await this.jj.resolveChange(request.repoRoot, id)).kind !== "unique")
                    throw new Error(`restored candidate absent: ${id}`);
                for (const id of classification.sourceContent)
                  if ((await this.jj.resolveChange(request.repoRoot, id)).kind !== "unique")
                    throw new Error(`restored content absent: ${id}`);
                if (!(await this.jj.workspaceHead(request.repoRoot, row.name)))
                  throw new Error("restored attachment absent");
                // A fully proved restore is retryable. Keep the original intent
                // and classification, but clear the applied-phase marker so the
                // next attempt can perform Phase A again.
                request.receipt = {
                  classification,
                  phaseA: { abandoned: [] },
                  phaseB: receipt.phaseB,
                };
                this.db
                  .prepare(
                    "UPDATE custody_operation SET state='intent',settled_at=NULL,heartbeat_at=?,evidence=? WHERE op_id=?",
                  )
                  .run(this.now(), JSON.stringify(request), opId);
                throw new PhaseARolledBackError(
                  `phase_a_rolled_back_retryable: ${String(proofError)}`,
                );
              } catch (restoreError) {
                if (restoreError instanceof PhaseARolledBackError) throw restoreError;
                await this.port.commit(opId, {
                  workspaceId: row.id,
                  ownRootSessionId: request.rootSessionId,
                  cause: "ambiguity",
                  disposition: "incident",
                  patch: {
                    incident: {
                      stage: "phase_a_unrestorable",
                      reason: `${String(proofError)}; restore: ${String(restoreError)}`,
                    },
                  },
                  now: this.now(),
                });
                throw new Error(`Phase A unrestorable: ${String(restoreError)}`);
              }
            }
          }
          let simplificationApplied = false;
          if (classification.incomingHeads.length) {
            // The target is the active checkout and rebase snapshots it itself.
            // update-stale belongs only to the source checkout; running it here
            // can displace the user's current working-copy state.
            const parents = await this.jj.parentsOfWorkingCopy(targetPath);
            await this.jj.rebaseWorkingCopyOnto(targetPath, [
              ...parents,
              ...classification.incomingHeads,
            ]);
            const mergedTarget = await this.jj.changeIdAt(targetPath, "@");
            const conflicted = await this.jj.hasConflicts(targetPath, exact(mergedTarget));
            const redundant =
              !conflicted && (await this.jj.hasRedundantParents(targetPath, mergedTarget));
            if (redundant) {
              await this.jj.simplifyParents(targetPath, mergedTarget);
              simplificationApplied = true;
            }
            const rewrittenTarget = await this.jj.changeIdAt(targetPath, "@");
            if (
              !(await this.jj.areAncestorsOf(
                targetPath,
                classification.incomingHeads,
                rewrittenTarget,
              ))
            )
              throw new Error("Merge ancestry proof failed after simplify-parents");
          }
          request.actualMerge = {
            strategy: "merge-under",
            changeIds: request.mergeChangeIds ?? classification.sourceContent,
            conflictPaths: classification.incomingHeads.length
              ? await this.jj.conflictedPaths(targetPath)
              : [],
            parentSimplification: simplificationApplied ? "applied" : "skipped",
            parentSimplificationReason: simplificationApplied
              ? "redundant-parents-removed"
              : "no-redundancy",
            classification,
            phaseA: receipt.phaseA,
            phaseB: receipt.phaseB,
          } as MergeSummary;
        }
      } else {
        if (!heads.length) throw new Error("Abandon requires owned heads");
        for (const head of heads)
          if (await this.jj.hasDescendantsOutside(request.repoRoot, head, heads))
            throw new Error("Abandon refused: owned change has foreign descendants");
        if (request.requestedBy === "scaffold_reclaim")
          await this.proveScaffold(request, row, heads[0]!);
        // JJ refuses to abandon a live working-copy commit. Updating stale is
        // mandatory before detachment; a present checkout failure fails closed.
        await this.updateSourceStale(row, "custody abandon");
        await this.jj.workspaceForget(request.repoRoot, row.name);
        for (const head of heads) {
          const evidence = await this.jj.resolveChange(request.repoRoot, head);
          if (evidence.kind === "unique") await this.jj.abandon(request.repoRoot, head);
          else if (evidence.kind !== "hidden")
            throw new Error(`Cannot prove abandon: ${evidence.kind}`);
        }
      }
      const after = await this.jj.currentOperationId(request.repoRoot);
      this.db
        .prepare(
          "UPDATE custody_operation SET state='jj_applied',jj_op_before=?,jj_op_after=?,heartbeat_at=?,evidence=? WHERE op_id=?",
        )
        .run(before, after, this.now(), JSON.stringify(request), opId);
      this.fault?.("after_jj", opId);
      op = this.operation(opId);
      if (!op) throw new Error("Custody operation disappeared after JJ mutation");
    }

    if (request.kind === "create") {
      const head = await this.jj.workspaceHead(request.repoRoot, row.name);
      if (!head) throw new Error("Created attachment is not present");
      row = {
        ...row,
        rootChangeId: row.rootChangeId ?? head,
        headChangeIds: [head],
        attachmentEvidence: "present",
        directoryEvidence: "present",
      };
      this.fault?.("after_receipt", opId);
      const result = await this.insertCreated(row, opId);
      this.fault?.("after_commit", opId);
      return result;
    }
    if (request.kind === "forget") {
      if (await this.jj.workspaceHead(request.repoRoot, row.name))
        throw new Error("Forget absence not proved");
      await rm(row.path, { recursive: true, force: true });
      this.fault?.("after_receipt", opId);
      const result = await this.port.commit(opId, {
        workspaceId: row.id,
        ownRootSessionId: request.rootSessionId,
        cause: "forget",
        disposition: "detached",
        patch: { attachmentEvidence: "absent", directoryEvidence: "absent" },
        now: this.now(),
      });
      this.fault?.("after_commit", opId);
      return result;
    }
    if (request.kind === "merge" || request.kind === "finalize_merge") {
      const target = request.targetChangeId!;
      const targetPath = request.targetPath ?? request.repoRoot;
      const proofHeads = request.actualMerge?.classification?.incomingHeads ?? heads;
      if (proofHeads.length && !(await this.jj.areAncestorsOf(targetPath, proofHeads, target)))
        throw new Error("Merge ancestry not proved");
      if (!request.actualMerge) throw new Error("Merge execution receipt is missing");
      if (await this.jj.hasConflicts(targetPath, exact(target))) {
        this.fault?.("after_receipt", opId);
        const result = await this.port.commit(opId, {
          workspaceId: row.id,
          ownRootSessionId: request.rootSessionId,
          cause: "merge_conflicts_retained",
          disposition: "attached",
          patch: {
            conflictRetained: true,
            mergedIntoChangeId: target,
            merge: request.actualMerge,
          },
          now: this.now(),
        });
        this.fault?.("after_commit", opId);
        return result;
      }
      await this.updateSourceStale(row, "custody merge cleanup");
      await this.jj.workspaceForget(request.repoRoot, row.name);
      if (await this.jj.workspaceHead(request.repoRoot, row.name))
        throw new Error("Merge detach not proved");
      await rm(row.path, { recursive: true, force: true });
      const mergeReceipt = request.actualMerge;
      const phaseBHead = mergeReceipt.classification?.attachedHead;
      if (phaseBHead) {
        const visibility = await this.jj.resolveChange(request.repoRoot, phaseBHead);
        if (visibility.kind === "unique") {
          if (await this.jj.areAncestorsOf(targetPath, [phaseBHead], target))
            throw new Error("Phase B refused: empty source head is reachable from target");
          // The head may have gained content while cleanup was in progress.
          if (!(await this.jj.isEmpty(request.repoRoot, exact(phaseBHead))))
            throw new Error("Phase B refused: source head gained content");
          const operation = await this.jj.abandonExactSet(request.repoRoot, [phaseBHead]);
          if ((await this.jj.resolveChange(request.repoRoot, phaseBHead)).kind !== "hidden")
            throw new Error("Phase B abandoned head absence not proved");
          request.actualMerge = {
            ...mergeReceipt,
            phaseB: { abandoned: [phaseBHead], operation },
          };
        } else if (visibility.kind === "hidden") {
          // `workspace forget` may itself abandon the empty WC. That is the
          // same proved Phase-B outcome and is safe across crash retries.
          request.actualMerge = {
            ...mergeReceipt,
            phaseB: { abandoned: [phaseBHead], operation: "workspace-forget" },
          };
        } else throw new Error("Phase B head visibility is ambiguous");
      }
      for (const id of mergeReceipt.classification?.linearInterior ?? [])
        if ((await this.jj.resolveChange(request.repoRoot, id)).kind !== "hidden")
          throw new Error(`Final Phase A absence not proved: ${id}`);
      for (const id of mergeReceipt.classification?.sourceContent ?? []) {
        if ((await this.jj.resolveChange(request.repoRoot, id)).kind !== "unique")
          throw new Error(`Final content visibility not proved: ${id}`);
        if (!(await this.jj.areAncestorsOf(targetPath, [id], target)))
          throw new Error(`Final content ancestry not proved: ${id}`);
      }
      this.fault?.("after_receipt", opId);
      const result = await this.port.commit(opId, {
        workspaceId: row.id,
        ownRootSessionId: request.rootSessionId,
        cause: "merge_proved",
        disposition: "merged",
        patch: {
          conflictRetained: false,
          mergedIntoChangeId: target,
          mergedProofOp: opId,
          attachmentEvidence: "absent",
          directoryEvidence: "absent",
          merge: request.actualMerge,
        },
        now: this.now(),
      });
      this.fault?.("after_commit", opId);
      return result;
    }
    // Receipt is written only after every exact owned head is proven hidden.
    for (const head of heads)
      if ((await this.jj.resolveChange(request.repoRoot, head)).kind !== "hidden")
        throw new Error("Abandon absence not proved");
    const receiptId = `abr_${createHash("sha256").update(opId).digest("hex").slice(0, 32)}`;
    this.db
      .prepare("INSERT OR IGNORE INTO abandon_receipt VALUES(?,?,?,?,?,?,?,1,?)")
      .run(
        receiptId,
        row.id,
        opId,
        request.requestedBy,
        JSON.stringify([...heads].sort()),
        op.jj_op_before,
        op.jj_op_after,
        this.now(),
      );
    this.fault?.("after_receipt", opId);
    await rm(row.path, { recursive: true, force: true });
    const result = await this.port.commit(opId, {
      workspaceId: row.id,
      ownRootSessionId: request.rootSessionId,
      cause: "abandon_receipted",
      disposition: "abandoned",
      patch: { attachmentEvidence: "absent", directoryEvidence: "absent" },
      now: this.now(),
    });
    this.fault?.("after_commit", opId);
    return result;
  }

  private async updateSourceStale(row: CustodyRecord, context: string): Promise<void> {
    const attached = await this.jj.workspaceHead(row.repoRoot, row.name);
    // Forget is path-independent and idempotent. A missing attachment needs no
    // refresh; a surviving attachment with a surviving checkout must be
    // refreshed before detachment. The path is evidence, never authority.
    if (!attached) return;
    if (await pathExists(row.path)) await this.jj.updateStale(row.path, context);
  }

  private async insertCreated(row: CustodyRecord, opId: string): Promise<CustodyRecord> {
    // SqliteWorkspaceCustody.insert recognizes the already durable intent.
    return this.port.insert(row, {
      opId,
      workspaceId: row.id,
      repoId: row.repoId,
      kind: "create",
      requestedBy: "system_spawn",
      pid: process.pid,
      processIdentity: this.processIdentity,
      changeIds: row.headChangeIds,
      now: this.now(),
    });
  }

  private async proveScaffold(
    request: CustodySagaRequest,
    row: CustodyRecord,
    head: string,
  ): Promise<void> {
    if (
      row.headChangeIds.length !== 1 ||
      !(await this.jj.isEmpty(request.repoRoot, exact(head))) ||
      (await this.jj.hasDescendants(request.repoRoot, head))
    )
      throw new Error("Scaffold changed before leased reclaim");
    const range = await this.jj.range(request.repoRoot, row.baseChangeIds, head);
    if (range.length !== 1 || range[0]!.changeId !== head || range[0]!.description.trim())
      throw new Error("Scaffold durable proof no longer holds");
  }

  /** The sole automatic destructive operation: a one-head, empty, undescribed, descendant-free scaffold. */
  async reclaimScaffold(
    request: Omit<CustodySagaRequest, "kind" | "requestedBy">,
  ): Promise<CustodyRecord> {
    const row = await this.port.get(request.workspaceId);
    if (!row || row.headChangeIds.length !== 1)
      throw new Error("Scaffold reclaim requires exactly one owned head");
    const head = row.headChangeIds[0]!;
    if (
      !(await this.jj.isEmpty(request.repoRoot, exact(head))) ||
      (await this.jj.hasDescendants(request.repoRoot, head))
    )
      throw new Error("Scaffold is not proved empty and descendant-free");
    const range = await this.jj.range(request.repoRoot, row.baseChangeIds, head);
    if (range.length !== 1 || range[0]!.description.trim())
      throw new Error("Scaffold has user description or history");
    return this.run({
      ...request,
      kind: "abandon",
      requestedBy: "scaffold_reclaim",
    });
  }
}

interface CustodyOperationRow {
  op_id: string;
  workspace_id: string;
  state: string;
  evidence: string;
  change_ids: string | null;
  jj_op_before: string | null;
  jj_op_after: string | null;
}

class PhaseARolledBackError extends Error {}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
