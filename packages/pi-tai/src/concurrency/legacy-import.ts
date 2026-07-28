import { createHash } from "node:crypto";
import type { DelegationRecord } from "../subagents/store.ts";
import { validateContextRecord, type ChildContextStore, type PersistedChildContextV4 } from "./persistence.ts";
import type { HostConcurrencyState } from "./host-state.ts";

export type LegacyQuarantineReason =
  | "invalid_record"
  | "subprocess_state"
  | "conflicting_mirror"
  | "ambiguous_workspace_identity"
  | "unproved_writer"
  | "execution_identity_missing";

export interface LegacyQuarantineV1 {
  version: 1;
  recordId: string;
  reason: LegacyQuarantineReason;
  detail: string;
  quarantinedAt: string;
}

export interface LegacyImportPlan {
  imports: PersistedChildContextV4[];
  quarantines: LegacyQuarantineV1[];
  skippedExistingIds: string[];
}

/** Deterministic, one-way v3 import. It never resumes a legacy process or guesses an execution identity. */
export function planLegacyContextImport(input: {
  records: unknown[];
  existing: PersistedChildContextV4[];
  rootSessionId: string;
  now: string;
}): LegacyImportPlan {
  const existing = new Map(input.existing.map((record) => [record.contextId, record]));
  const imports: PersistedChildContextV4[] = [];
  const quarantines: LegacyQuarantineV1[] = [];
  const skippedExistingIds: string[] = [];
  const quarantine = (recordId: string, reason: LegacyQuarantineReason, detail: string) => quarantines.push({ version: 1, recordId, reason, detail, quarantinedAt: input.now });

  for (const candidate of input.records) {
    if (!record(candidate) || candidate.version !== 3 || typeof candidate.id !== "string") { quarantine("unknown", "invalid_record", "Legacy child record must be a version 3 object with an id."); continue; }
    const legacy = candidate as unknown as DelegationRecord;
    if (existing.has(legacy.id)) {
      const current = existing.get(legacy.id)!;
      if (current.legacy?.delegationId === legacy.id && current.task.objective === legacy.task?.objective && current.agent.contentHash === legacy.agent?.contentHash) skippedExistingIds.push(legacy.id);
      else quarantine(legacy.id, "conflicting_mirror", "Legacy and Host records disagree or lack a proved prior import receipt.");
      continue;
    }
    if (candidate.workspace && candidate.legacyWorkspace) { quarantine(legacy.id, "ambiguous_workspace_identity", "Both legacy workspace representations are present."); continue; }
    if ([candidate.pid, candidate.controlPath, candidate.managedLogPath, candidate.childSessionFile].some((value) => value !== undefined)) { quarantine(legacy.id, "subprocess_state", "Legacy subprocess identity is never resumed or imported."); continue; }
    const phase = legacy.execution?.phase;
    if (phase === "running" || phase === "awaiting_parent") { quarantine(legacy.id, "unproved_writer", `Legacy ${phase} execution has no quiescence proof.`); continue; }
    if (["completed", "blocked", "failed", "cancelled"].includes(String(phase))) { quarantine(legacy.id, "execution_identity_missing", `Legacy ${phase} execution has no exact cycle and terminal-event identity.`); continue; }
    if (phase !== "created" && phase !== "abandoned") { quarantine(legacy.id, "invalid_record", `Unsupported legacy execution phase: ${String(phase)}.`); continue; }
    try {
      const cycleId = stableId("migration-cycle", legacy.id);
      const incidentEventId = stableId("migration-incident", legacy.id);
      const migrated = validateContextRecord({
        version: 4, contextId: legacy.id, rootSessionId: input.rootSessionId, ...(legacy.parentDelegationId ? { parentContextId: legacy.parentDelegationId } : {}), cwd: legacy.cwd,
        task: legacy.task, agent: legacy.agent,
        execution: phase === "created" ? { phase: "created", cycleId } : { phase: "incident", reason: legacy.execution.reason ?? "Legacy delegation was abandoned.", stoppedAt: legacy.updatedAt },
        events: phase === "abandoned" ? [{ eventId: incidentEventId, contextId: legacy.id, kind: "incident", payload: { reason: legacy.execution.reason ?? "Legacy delegation was abandoned." }, delivery: { phase: "persisted", createdAt: input.now } }] : [],
        usage: [], telemetryGaps: [], createdAt: legacy.createdAt, updatedAt: input.now, legacy: { delegationId: legacy.id, version: 3 },
      });
      imports.push(migrated);
    } catch (error) { quarantine(legacy.id, "invalid_record", error instanceof Error ? error.message : String(error)); }
  }
  return { imports, quarantines, skippedExistingIds };
}

export class HostLegacyContextMigrator {
  private readonly contexts: ChildContextStore;
  private readonly state: HostConcurrencyState;
  private readonly now: () => string;
  constructor(contexts: ChildContextStore, state: HostConcurrencyState, now: () => string = () => new Date().toISOString()) { this.contexts = contexts; this.state = state; this.now = now; }
  async run(rootSessionId: string, records: unknown[]): Promise<LegacyImportPlan> {
    const markers = await this.state.readSegment<{ rootSessionId: string }>("migrationReceipts");
    if (markers.some((marker) => marker.rootSessionId === rootSessionId)) return { imports: [], quarantines: [], skippedExistingIds: [] };
    const plan = planLegacyContextImport({ records, existing: await this.contexts.list(), rootSessionId, now: this.now() });
    for (const migrated of plan.imports) await this.contexts.create(migrated);
    if (plan.quarantines.length) await this.state.mutateSegment<LegacyQuarantineV1>("migrationQuarantines", "migration.quarantined", { count: plan.quarantines.length }, (items) => [...items, ...plan.quarantines]);
    await this.state.mutateSegment<{ version: 1; rootSessionId: string; imported: number; quarantined: number; completedAt: string }>("migrationReceipts", "migration.completed", { rootSessionId }, (items) => [...items, { version: 1, rootSessionId, imported: plan.imports.length, quarantined: plan.quarantines.length, completedAt: this.now() }]);
    return plan;
  }
}

function stableId(prefix: string, value: string): string { return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`; }
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
