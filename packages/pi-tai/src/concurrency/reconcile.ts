import type { InlineExtension, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildContextStore, PersistedChildContextV4 } from "./persistence.ts";

export interface ReconciliationCoordinator {
  getRuntime(contextId: string): unknown;
  resume(input: {
    contextId: string;
    modelRegistry: ModelRegistry;
    extensions?: readonly InlineExtension[];
    reconciliationSummary: string;
  }): Promise<PersistedChildContextV4>;
}
import type { ChildEventWaitRegistry } from "./waits.ts";
import { isResolvedDelegation, type DelegationRecord } from "../subagents/store.ts";

type ModelRegistry = ExtensionContext["modelRegistry"];

export type ReconciliationDisposition =
  | "retained_live"
  | "resumed"
  | "terminal"
  | "cancelled"
  | "question_pending"
  | "incident"
  | "mutation_stopped";

export interface ReconciledContext {
  contextId: string;
  depth: number;
  disposition: ReconciliationDisposition;
  reason: string;
}

export function classifyLegacyContext(record: DelegationRecord, _processAlive: boolean): ReconciliationDisposition {
  if (isResolvedDelegation(record)) return record.execution.phase === "cancelled" ? "cancelled" : "terminal";
  // A v3 process has no attributable execution-cycle/mutation receipt boundary. Even a dead PID
  // is inspect/recovery-only until explicit migration proves workspace and mutation quiescence.
  return "mutation_stopped";
}

export function classifyContext(
  record: PersistedChildContextV4,
  runtimePresent: boolean,
): ReconciliationDisposition {
  switch (record.execution.phase) {
    case "completed": case "blocked": case "failed": return "terminal";
    case "cancelled": return "cancelled";
    case "incident": return /mutation|identity|writer|quiesc/i.test(record.execution.reason) ? "mutation_stopped" : "incident";
    case "awaiting_parent": return "question_pending";
    case "interrupted": return /mutation|identity|writer|quiesc/i.test(record.execution.reason) ? "mutation_stopped" : "resumed";
    case "created": case "starting": case "running": return runtimePresent ? "retained_live" : "resumed";
  }
}

export interface ChildContextReconcilerOptions {
  store: ChildContextStore;
  coordinator: ReconciliationCoordinator;
  waits: ChildEventWaitRegistry;
  now?: () => string;
}

export class ChildContextReconciler {
  private readonly store: ChildContextStore;
  private readonly coordinator: ReconciliationCoordinator;
  private readonly waits: ChildEventWaitRegistry;
  private readonly now: () => string;

  constructor(options: ChildContextReconcilerOptions) {
    this.store = options.store;
    this.coordinator = options.coordinator;
    this.waits = options.waits;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async reconcile(input: {
    rootSessionId: string;
    modelRegistry: ModelRegistry;
    extensions?: (contextId: string) => readonly InlineExtension[];
  }): Promise<ReconciledContext[]> {
    this.waits.clear("cancelled");
    const records = (await this.store.list()).filter((record) => record.rootSessionId === input.rootSessionId);
    const depths = depthMap(records);
    const ordered = [...records].sort((left, right) =>
      (depths.get(right.contextId) ?? 0) - (depths.get(left.contextId) ?? 0)
      || left.contextId.localeCompare(right.contextId),
    );
    const output: ReconciledContext[] = [];
    for (const original of ordered) {
      let record = original;
      const runtimePresent = Boolean(this.coordinator.getRuntime(record.contextId));
      let disposition = classifyContext(record, runtimePresent);
      if (disposition === "resumed" && record.execution.phase !== "interrupted") {
        const cycleId = record.execution.cycleId;
        if (!cycleId) throw new Error(`Resumable context ${record.contextId} has no execution cycle identity.`);
        record = await this.store.update(record.contextId, (current) => ({
          ...current,
          execution: {
            phase: "interrupted",
            cycleId,
            reason: "Root restart removed the in-memory SDK context.",
            interruptedAt: this.now(),
            ...(current.execution.phase === "running" || current.execution.phase === "awaiting_parent"
              ? { sessionFile: current.execution.sessionFile }
              : {}),
          },
          updatedAt: this.now(),
        }));
      }
      if (disposition === "resumed") {
        const descendants = output.filter((candidate) => isDescendant(candidate.contextId, record.contextId, records));
        const summary = descendants.length
          ? `Resume after descendant reconciliation: ${descendants.map((item) => `${item.contextId}:${item.disposition}`).join(", ")}.`
          : "Resume after deterministic reconciliation; no unresolved descendant disposition changed.";
        const resumed = await this.coordinator.resume({
          contextId: record.contextId,
          modelRegistry: input.modelRegistry,
          extensions: input.extensions?.(record.contextId),
          reconciliationSummary: summary,
        });
        disposition = resumed.execution.phase === "running" ? "resumed" : "incident";
      }
      output.push({
        contextId: record.contextId,
        depth: depths.get(record.contextId) ?? 0,
        disposition,
        reason: dispositionReason(disposition),
      });
    }
    return output;
  }
}

function depthMap(records: readonly PersistedChildContextV4[]): Map<string, number> {
  const byId = new Map(records.map((record) => [record.contextId, record]));
  const result = new Map<string, number>();
  for (const record of records) {
    let depth = 0;
    let parent = record.parentContextId;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      if (!byId.has(parent)) break;
      depth += 1;
      parent = byId.get(parent)?.parentContextId;
    }
    result.set(record.contextId, depth);
  }
  return result;
}
function isDescendant(candidateId: string, ancestorId: string, records: readonly PersistedChildContextV4[]): boolean {
  const byId = new Map(records.map((record) => [record.contextId, record]));
  let parent = byId.get(candidateId)?.parentContextId;
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) {
    if (parent === ancestorId) return true;
    seen.add(parent);
    parent = byId.get(parent)?.parentContextId;
  }
  return false;
}
function dispositionReason(disposition: ReconciliationDisposition): string {
  switch (disposition) {
    case "retained_live": return "Existing SDK runtime remains active.";
    case "resumed": return "A linked replacement cycle was created after quiescence.";
    case "terminal": return "Terminal work is not recreated.";
    case "cancelled": return "Explicitly cancelled cycles do not auto-resume.";
    case "question_pending": return "One unanswered parent question remains pending.";
    case "incident": return "Incident custody is preserved for inspection.";
    case "mutation_stopped": return "Mutation or writer quiescence cannot be proved automatically.";
  }
}
