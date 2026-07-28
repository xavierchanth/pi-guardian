import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { WorkspaceId } from "./domain.ts";
import type { JjWorkspaceRepositoryKernel, WorkspaceRangeEntry } from "./workspace-repository.ts";
import type { IsolatedWorkspaceStore, PersistedIsolatedWorkspaceV1, PersistedWorkspaceOperationV1 } from "./workspace-persistence.ts";

export type WorkspaceRecoveryDisposition =
  | "consistent"
  | "refreshable"
  | "not_started"
  | "completed_unrecorded"
  | "resumable"
  | "reconstructable"
  | "review_stale"
  | "owned_conflict"
  | "breached"
  | "attention_required"
  | "cleanup_pending";

export interface WorkspaceRecoveryDiscrepancy {
  readonly kind:
    | "attachment_missing"
    | "head_mismatch"
    | "operation_advanced"
    | "interrupted_claim"
    | "unknown_operation"
    | "foreign_descendants"
    | "conflicted_range"
    | "custody_uninspectable";
  readonly summary: string;
}

export interface WorkspaceRecoverySnapshot {
  readonly version: 1;
  readonly workspaceId: string;
  readonly custodyPhase: PersistedIsolatedWorkspaceV1["phase"];
  readonly attachment: {
    readonly directory: "present" | "missing" | "unknown";
    readonly path?: string;
  };
  readonly graph: {
    readonly expectedRootChangeId?: string;
    readonly expectedHeadChangeId?: string;
    readonly observedHeadChangeId?: string;
    readonly observedHeadEmpty?: boolean;
    readonly orderedChangeIds: readonly string[];
    readonly foreignDescendantIds: readonly string[];
    readonly conflictPaths: readonly string[];
  };
  readonly writerPhase?: string;
  readonly latestOperation?: {
    readonly operationId: string;
    readonly kind: PersistedWorkspaceOperationV1["kind"];
    readonly outcome: PersistedWorkspaceOperationV1["outcome"]["phase"];
    readonly boundary?: string;
    readonly beforeJjOperationId: string;
  };
  readonly observedJjOperationId?: string;
  readonly discrepancies: readonly WorkspaceRecoveryDiscrepancy[];
  readonly evidenceDigest: string;
}

export interface WorkspaceRecoveryAction {
  readonly actionId: string;
  readonly kind:
    | "continue"
    | "refresh_evidence"
    | "replay_operation"
    | "synthesize_receipt"
    | "resume_operation"
    | "reconstruct_attachment"
    | "invalidate_review"
    | "enter_conflict_reconciliation"
    | "enter_breach"
    | "retry_cleanup"
    | "preserve_incident";
  readonly automatic: boolean;
  readonly summary: string;
}

export interface WorkspaceRecoveryPlan {
  readonly version: 1;
  readonly planId: string;
  readonly workspaceId: string;
  readonly snapshotDigest: string;
  readonly disposition: WorkspaceRecoveryDisposition;
  readonly actions: readonly WorkspaceRecoveryAction[];
}

export class WorkspaceRecoveryInspector {
  private readonly workspaces: IsolatedWorkspaceStore;
  private readonly repository: JjWorkspaceRepositoryKernel;
  constructor(workspaces: IsolatedWorkspaceStore, repository: JjWorkspaceRepositoryKernel) {
    this.workspaces = workspaces;
    this.repository = repository;
  }

  async inspect(id: WorkspaceId): Promise<WorkspaceRecoverySnapshot> {
    const record = await this.workspaces.get(id);
    if (!record) throw new Error(`Unknown isolated workspace: ${id}`);
    const discrepancies: WorkspaceRecoveryDiscrepancy[] = [];
    const identity = "identity" in record ? record.identity : undefined;
    let directory: WorkspaceRecoverySnapshot["attachment"]["directory"] = "unknown";
    if (identity?.path) {
      try { await stat(identity.path); directory = "present"; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          directory = "missing";
          discrepancies.push({ kind: "attachment_missing", summary: "The managed workspace directory is missing." });
        }
      }
    }

    let observedHeadChangeId: string | undefined;
    let observedHeadEmpty: boolean | undefined;
    let observedJjOperationId: string | undefined;
    let ordered: WorkspaceRangeEntry[] = [];
    let foreignDescendantIds: string[] = [];
    let conflictPaths: string[] = [];
    if (identity && directory === "present") {
      try {
        const inspection = await this.repository.inspect(id);
        observedHeadChangeId = inspection.head.changeId;
        observedHeadEmpty = inspection.head.empty;
        observedJjOperationId = inspection.operationId;
        if (observedHeadChangeId !== identity.expectedHeadChangeId) discrepancies.push({ kind: "head_mismatch", summary: `Expected head ${identity.expectedHeadChangeId}, observed ${observedHeadChangeId}.` });
        try {
          ordered = await this.repository.range(id, identity.rootChangeId as any, identity.expectedHeadChangeId as any);
        } catch (error) {
          discrepancies.push({ kind: "custody_uninspectable", summary: `Unable to inspect the tracked workspace range: ${error instanceof Error ? error.message : String(error)}` });
        }
        try {
          foreignDescendantIds = await this.repository.foreignDescendants(id, identity.rootChangeId as any, identity.expectedHeadChangeId as any);
        } catch (error) {
          discrepancies.push({ kind: "custody_uninspectable", summary: `Unable to inspect foreign descendants: ${error instanceof Error ? error.message : String(error)}` });
        }
        if (foreignDescendantIds.length) discrepancies.push({ kind: "foreign_descendants", summary: `Observed ${foreignDescendantIds.length} foreign descendant(s).` });
        conflictPaths = [...new Set((await Promise.all(ordered.map((entry) => this.repository.conflicts(id, `exactly(change_id(${entry.changeId}), 1)`)))).flat())].sort();
        if (conflictPaths.length) discrepancies.push({ kind: "conflicted_range", summary: `Observed ${conflictPaths.length} conflicted path(s).` });
      } catch (error) {
        discrepancies.push({ kind: "custody_uninspectable", summary: error instanceof Error ? error.message : String(error) });
      }
    }

    const operations = "operations" in record ? record.operations : [];
    const latest = [...operations].reverse().find((operation) => operation.outcome.phase === "started" || operation.outcome.phase === "unknown") ?? operations.at(-1);
    if (latest && observedJjOperationId && observedJjOperationId !== latest.beforeJjOperationId && latest.outcome.phase === "started") discrepancies.push({ kind: "operation_advanced", summary: "JJ operation state advanced after the persisted operation began." });
    if (latest?.outcome.phase === "unknown") discrepancies.push({ kind: "unknown_operation", summary: `Operation ${latest.operationId} has unknown partial mutation.` });
    const writerPhase = record.phase === "active" ? record.writer.phase : undefined;
    if (writerPhase === "interrupted") discrepancies.push({ kind: "interrupted_claim", summary: "Workspace writer authority was interrupted." });

    const base = {
      version: 1 as const,
      workspaceId: String(id),
      custodyPhase: record.phase,
      attachment: { directory, ...(identity?.path ? { path: identity.path } : {}) },
      graph: {
        ...(identity ? { expectedRootChangeId: identity.rootChangeId, expectedHeadChangeId: identity.expectedHeadChangeId } : {}),
        ...(observedHeadChangeId ? { observedHeadChangeId } : {}),
        ...(observedHeadEmpty !== undefined ? { observedHeadEmpty } : {}),
        orderedChangeIds: ordered.map((entry) => String(entry.changeId)),
        foreignDescendantIds,
        conflictPaths,
      },
      ...(writerPhase ? { writerPhase } : {}),
      ...(latest ? { latestOperation: { operationId: latest.operationId, kind: latest.kind, outcome: latest.outcome.phase, ...(latest.outcome.phase === "started" ? { boundary: latest.outcome.boundary } : {}), beforeJjOperationId: latest.beforeJjOperationId } } : {}),
      ...(observedJjOperationId ? { observedJjOperationId } : {}),
      discrepancies,
    };
    return { ...base, evidenceDigest: digest(base) };
  }
}

export class WorkspaceRecoveryPlanner {
  plan(snapshot: WorkspaceRecoverySnapshot): WorkspaceRecoveryPlan {
    const disposition = classifyWorkspaceRecovery(snapshot);
    const actions = actionsFor(disposition);
    const base = { version: 1 as const, workspaceId: snapshot.workspaceId, snapshotDigest: snapshot.evidenceDigest, disposition, actions };
    return { ...base, planId: `recovery-${digest(base)}` };
  }
}

export function classifyWorkspaceRecovery(snapshot: WorkspaceRecoverySnapshot): WorkspaceRecoveryDisposition {
  if (snapshot.discrepancies.some((item) => item.kind === "custody_uninspectable")) return "attention_required";
  if (snapshot.custodyPhase === "cleanup_pending") return "cleanup_pending";
  if (snapshot.graph.foreignDescendantIds.length) return "attention_required";
  if (snapshot.attachment.directory === "missing" && snapshot.graph.expectedHeadChangeId) {
    if (snapshot.custodyPhase === "integrating") return "resumable";
    if (["integrated", "verifying", "closed", "closed_no_changes"].includes(snapshot.custodyPhase)) return "consistent";
    return "reconstructable";
  }
  if (snapshot.graph.conflictPaths.length) return "owned_conflict";
  if (snapshot.latestOperation?.outcome === "unknown") return "attention_required";
  if (snapshot.writerPhase === "interrupted") {
    if (snapshot.latestOperation?.outcome === "started" && snapshot.latestOperation.boundary === "prepared" && snapshot.observedJjOperationId === snapshot.latestOperation.beforeJjOperationId) return "not_started";
    if (snapshot.latestOperation?.outcome === "started") return "resumable";
    return "attention_required";
  }
  if (snapshot.graph.expectedHeadChangeId && snapshot.graph.observedHeadChangeId && snapshot.graph.expectedHeadChangeId !== snapshot.graph.observedHeadChangeId) {
    const latest = snapshot.latestOperation;
    if (latest?.kind === "workspace_checkpoint" && latest.outcome === "started" && snapshot.graph.observedHeadEmpty) return "completed_unrecorded";
    return "attention_required";
  }
  if (snapshot.discrepancies.some((item) => item.kind === "operation_advanced")) return "refreshable";
  return "consistent";
}

function actionsFor(disposition: WorkspaceRecoveryDisposition): WorkspaceRecoveryAction[] {
  const value: Record<WorkspaceRecoveryDisposition, readonly [WorkspaceRecoveryAction["kind"], boolean, string]> = {
    consistent: ["continue", true, "Continue the current workspace lifecycle."],
    refreshable: ["refresh_evidence", true, "Refresh derived JJ and graph evidence."],
    not_started: ["replay_operation", true, "Replay the exact persisted operation intent."],
    completed_unrecorded: ["synthesize_receipt", true, "Synthesize the missing receipt from exact postconditions."],
    resumable: ["resume_operation", true, "Resume only the next proved idempotent boundary."],
    reconstructable: ["reconstruct_attachment", true, "Reconstruct exact managed workspace state from owned evidence."],
    review_stale: ["invalidate_review", true, "Invalidate stale review evidence and return to review preparation."],
    owned_conflict: ["enter_conflict_reconciliation", true, "Enter owned conflict-reconciliation custody."],
    breached: ["enter_breach", true, "Stop affected writers and preserve ownership-breach evidence."],
    attention_required: ["preserve_incident", false, "Preserve evidence because no unique automatic recovery is proved."],
    cleanup_pending: ["retry_cleanup", true, "Retry only the exact recorded managed cleanup."],
  };
  const [kind, automatic, summary] = value[disposition];
  return [{ actionId: `${kind}-1`, kind, automatic, summary }];
}

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
