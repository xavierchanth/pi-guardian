export type SubagentMutationRetry = "never" | "after_state_change" | "idempotent" | "indeterminate";

export type SubagentMutationNext =
  | { action: "ack_child_event"; eventId: string }
  | { action: "respond_to_child"; questionId: string }
  | { action: "await_child_event"; contextIds: string[] }
  | { action: "reconcile_children" }
  | { action: "spawn_retry"; priorContextId: string }
  | { action: "continue_without_child" }
  | { action: "report_blocked"; reason: string };

export interface SubagentMutationFailure {
  readonly kind:
    | "child_terminal"
    | "terminal_unacknowledged"
    | "child_awaiting_response"
    | "child_cancelling"
    | "child_interrupted"
    | "child_incident"
    | "runtime_unavailable"
    | "stale_execution_cycle"
    | "stale_question"
    | "question_already_answered"
    | "event_not_delivered"
    | "delivery_race"
    | "delivery_indeterminate";
  readonly contextId?: string;
  readonly cycleId?: string;
  readonly phase?: string;
  readonly retry: SubagentMutationRetry;
  readonly next: SubagentMutationNext;
}

export class SubagentMutationError extends Error {
  readonly outcome: SubagentMutationFailure;
  constructor(outcome: SubagentMutationFailure, detail?: string) {
    super(renderSubagentMutationFailure(outcome, detail));
    this.name = "SubagentMutationError";
    this.outcome = outcome;
  }
}

export function renderSubagentMutationFailure(outcome: SubagentMutationFailure, detail?: string): string {
  return `Subagent mutation rejected: ${JSON.stringify({ ...outcome, ...(detail ? { detail } : {}) })}`;
}
