import { createHash } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { type ProcessState, processState, withOperationLease } from "../storage/operation-lease.ts";
import type { CustodyRecord, WorkspaceCustodyPort } from "./custody-port.ts";
import type { MergeSummary } from "./domain.ts";
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

  private operation(opId: string): any {
    return this.db.prepare("SELECT * FROM custody_operation WHERE op_id=?").get(opId);
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
          const retained = (row.merge as any).classification;
          const current = await this.jj.classifyMergeSource(
            request.repoRoot,
            row.name,
            request.targetChangeId,
          );
          if (
            !retained ||
            JSON.stringify(classificationIdentity(current)) !==
              JSON.stringify(classificationIdentity(retained))
          )
            throw new Error("Retained merge classification changed; finalization refused");
          request.actualMerge = row.merge;
        } else {
          if (alreadyAncestor) throw new Error("Fresh merge source is already in target ancestry");
          await this.updateSourceStale(row, "custody merge source");
          const classification = await this.jj.classifyMergeSource(
            request.repoRoot,
            row.name,
            request.targetChangeId,
          );
          if (classification.emptyMerges.length || classification.exceptional.length)
            throw new Error(
              `Unsafe empty revisions: ${JSON.stringify({ emptyMerges: classification.emptyMerges, exceptional: classification.exceptional })}`,
            );
          const receipt: any = {
            classification,
            phaseA: { abandoned: [] },
            phaseB: { abandoned: [] },
          };
          this.db
            .prepare("UPDATE custody_operation SET evidence=? WHERE op_id=?")
            .run(JSON.stringify({ ...request, receipt }), opId);
          if (classification.linearInterior.length) {
            const prePhaseA = await this.jj.currentOperationId(request.repoRoot);
            const phaseAOp = await this.jj.abandonExactSet(
              request.repoRoot,
              classification.linearInterior,
            );
            receipt.phaseA = {
              abandoned: classification.linearInterior,
              preOperation: prePhaseA,
              operation: phaseAOp,
            };
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
                const now = this.now();
                this.db
                  .prepare(
                    "UPDATE custody_operation SET state='failed',settled_at=?,heartbeat_at=?,evidence=? WHERE op_id=?",
                  )
                  .run(
                    now,
                    now,
                    JSON.stringify({
                      rolledBack: true,
                      failedProof: String(proofError),
                      restoredOperation: prePhaseA,
                    }),
                    opId,
                  );
                throw new PhaseARolledBackError(String(proofError));
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
          if (classification.incomingHeads.length) {
            await this.jj.updateStale(targetPath, "custody merge target");
            const parents = await this.jj.parentsOfWorkingCopy(targetPath);
            await this.jj.rebaseWorkingCopyOnto(targetPath, [
              ...parents,
              ...classification.incomingHeads,
            ]);
            // Ratified MG-0 protocol: simplify exactly the target WC, unconditionally.
            await this.jj.simplifyParents(targetPath, await this.jj.changeIdAt(targetPath, "@"));
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
            parentSimplification: classification.incomingHeads.length ? "applied" : "skipped",
            parentSimplificationReason: classification.incomingHeads.length
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
      const proofHeads = ((request.actualMerge as any)?.classification?.incomingHeads ??
        heads) as string[];
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
      const mergeReceipt = request.actualMerge as any;
      const phaseBHead = mergeReceipt.classification?.attachedHead as string | undefined;
      if (phaseBHead) {
        if ((await this.jj.resolveChange(request.repoRoot, phaseBHead)).kind !== "unique")
          throw new Error("Phase B head is not uniquely visible");
        if (await this.jj.areAncestorsOf(targetPath, [phaseBHead], target))
          throw new Error("Phase B refused: empty source head is reachable from target");
        const operation = await this.jj.abandonExactSet(request.repoRoot, [phaseBHead]);
        if ((await this.jj.resolveChange(request.repoRoot, phaseBHead)).kind !== "hidden")
          throw new Error("Phase B abandoned head absence not proved");
        mergeReceipt.phaseB = { abandoned: [phaseBHead], operation };
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
    if (!(await pathExists(row.path)))
      throw new Error(
        `${context} refused: attached checkout is absent; update-stale cannot be proved`,
      );
    if (!(await this.jj.workspaceHead(row.repoRoot, row.name)))
      throw new Error(`${context} refused: workspace attachment is absent`);
    await this.jj.updateStale(row.path, context);
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

class PhaseARolledBackError extends Error {}

function classificationIdentity(value: any) {
  return {
    sourceAt: value.sourceAt,
    sourceUnique: value.sourceUnique,
    sourceEmpty: value.sourceEmpty,
    sourceContent: value.sourceContent,
    incomingHeads: value.incomingHeads,
    attachedHead: value.attachedHead,
    linearInterior: value.linearInterior,
    emptyMerges: value.emptyMerges,
    exceptional: value.exceptional,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
