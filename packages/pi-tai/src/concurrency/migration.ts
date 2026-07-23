import type { ChildContextRecord } from "./domain.ts";
import {
  childContextId,
  rootSessionId,
} from "./ids.ts";

export type ChildContextMigration =
  | { kind: "loaded"; sourceVersion: 3; record: ChildContextRecord }
  | {
      kind: "quarantined";
      sourceVersion?: number;
      reason:
        | "invalid_record"
        | "unsupported_version"
        | "live_writer_unproven"
        | "execution_identity_missing";
      detail: string;
    };

export function migrateDelegationRecord(input: unknown): ChildContextMigration {
  if (!isRecord(input)) return quarantine("invalid_record", "Delegation record must be an object.");
  const version = typeof input.version === "number" ? input.version : undefined;
  if (version !== 3) {
    return quarantine("unsupported_version", `Expected delegation version 3, received ${String(input.version)}.`, version);
  }
  try {
    const id = requiredString(input.id, "id");
    const parentSession = requiredString(input.parentSessionId, "parentSessionId");
    const task = requiredRecord(input.task, "task");
    const agent = requiredRecord(input.agent, "agent");
    const execution = requiredRecord(input.execution, "execution");
    const phase = requiredString(execution.phase, "execution.phase");
    const createdAt = isoTime(input.createdAt, "createdAt");
    const updatedAt = isoTime(input.updatedAt, "updatedAt");

    if (phase === "running" || phase === "awaiting_parent") {
      return quarantine(
        "live_writer_unproven",
        `Legacy ${phase} execution has no durable execution-cycle identity or quiescence proof.`,
        version,
      );
    }
    if (phase === "completed" || phase === "blocked" || phase === "failed" || phase === "cancelled") {
      return quarantine(
        "execution_identity_missing",
        `Legacy ${phase} execution cannot be attributed to an exact execution cycle/event.`,
        version,
      );
    }
    if (phase !== "created" && phase !== "abandoned") {
      return quarantine("invalid_record", `Unknown legacy execution phase: ${phase}.`, version);
    }

    const record: ChildContextRecord = {
      contextId: childContextId(id),
      rootSessionId: rootSessionId(parentSession),
      ...(typeof input.parentDelegationId === "string"
        ? { parentContextId: childContextId(input.parentDelegationId) }
        : {}),
      intent: {
        role: requiredString(agent.name, "agent.name"),
        objective: requiredString(task.objective, "task.objective"),
        cwdKind: input.workspace || input.legacyWorkspace ? "isolated" : "source",
      },
      execution: phase === "created"
        ? { phase: "created" }
        : {
            phase: "incident",
            reason: typeof execution.reason === "string" && execution.reason.trim()
              ? execution.reason.trim()
              : "Legacy delegation was abandoned.",
            stoppedAt: updatedAt,
          },
      createdAt,
      updatedAt,
    };
    return { kind: "loaded", sourceVersion: 3, record };
  } catch (error) {
    return quarantine("invalid_record", error instanceof Error ? error.message : String(error), version);
  }
}

function quarantine(
  reason: Extract<ChildContextMigration, { kind: "quarantined" }>["reason"],
  detail: string,
  sourceVersion?: number,
): ChildContextMigration {
  return { kind: "quarantined", ...(sourceVersion === undefined ? {} : { sourceVersion }), reason, detail };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string.`);
  return value.trim();
}

function isoTime(value: unknown, label: string): string {
  const text = requiredString(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} must be an ISO-compatible timestamp.`);
  return text;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
