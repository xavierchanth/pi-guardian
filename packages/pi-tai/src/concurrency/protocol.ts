import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChildContextStore, PersistedChildContextV4, PersistedChildEventV4 } from "./persistence.ts";

export interface ChildMessageTarget {
  message(
    contextId: string,
    input: { customType: string; content: string; details: unknown; delivery?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
  ): Promise<void>;
}

export type ChildTerminalOutcome = "completed" | "blocked" | "failed" | "cancelled";

export type ChildEventInput =
  | { kind: "question"; question: string; options?: readonly string[]; recommendation?: string }
  | { kind: "status"; requestId: string; summary: string; completed?: readonly string[]; current?: string; remaining?: readonly string[]; blockers?: readonly string[] }
  | { kind: "terminal"; outcome: ChildTerminalOutcome; summary: string; validation?: readonly string[]; changedFiles?: readonly string[]; concerns?: readonly string[] }
  | { kind: "incident"; reason: string; recoveryDisposition: "retryable" | "mutation_stopped" | "terminal" };

export interface ChildEventProtocolOptions {
  store: ChildContextStore;
  coordinator: ChildMessageTarget;
  rootBridge: ExtensionAPI;
  now?: () => string;
  id?: () => string;
}

export class ChildEventProtocol {
  private readonly store: ChildContextStore;
  private readonly coordinator: ChildMessageTarget;
  private readonly rootBridge: ExtensionAPI;
  private readonly now: () => string;
  private readonly id: () => string;

  constructor(options: ChildEventProtocolOptions) {
    this.store = options.store;
    this.coordinator = options.coordinator;
    this.rootBridge = options.rootBridge;
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? randomUUID;
  }

  async emit(contextId: string, cycleId: string, input: ChildEventInput): Promise<PersistedChildEventV4> {
    const context = await this.requireContext(contextId, cycleId);
    if (input.kind === "question") {
      const unresolved = context.events.find((event) => event.kind === "question" && !isQuestionAnswered(event));
      if (unresolved) throw new Error(`Child cycle already has unresolved question ${unresolved.eventId}.`);
    }
    const timestamp = this.now();
    const event: PersistedChildEventV4 = {
      eventId: this.id(),
      contextId,
      cycleId,
      kind: input.kind,
      payload: normalizeInput(input),
      delivery: { phase: "persisted", createdAt: timestamp },
    };
    await this.store.update(contextId, (current) => ({
      ...current,
      ...(input.kind === "terminal" ? {
        execution: {
          phase: input.outcome,
          cycleId,
          terminalEventId: event.eventId,
          finishedAt: timestamp,
        },
      } : input.kind === "question" && current.execution.phase === "running" ? {
        execution: {
          phase: "awaiting_parent",
          cycleId,
          questionEventId: event.eventId,
          startedAt: current.execution.startedAt,
          sessionId: current.execution.sessionId,
          sessionFile: current.execution.sessionFile,
        },
      } : {}),
      events: [...current.events, event],
      updatedAt: timestamp,
    }));
    await this.deliver(context, event);
    return (await this.requireEvent(contextId, event.eventId));
  }

  async retryUndelivered(contextId: string): Promise<PersistedChildEventV4[]> {
    const context = await this.requireContext(contextId);
    const delivered: PersistedChildEventV4[] = [];
    for (const event of context.events.filter((candidate) => candidate.delivery.phase === "persisted")) {
      await this.deliver(context, event);
      delivered.push(await this.requireEvent(contextId, event.eventId));
    }
    return delivered;
  }

  async acknowledge(contextId: string, eventId: string): Promise<PersistedChildEventV4> {
    const timestamp = this.now();
    await this.store.update(contextId, (current) => ({
      ...current,
      events: current.events.map((event) => {
        if (event.eventId !== eventId) return event;
        if (event.delivery.phase === "acknowledged") return event;
        if (event.delivery.phase !== "delivered") throw new Error("A child event must be delivered before acknowledgement.");
        return { ...event, delivery: { ...event.delivery, phase: "acknowledged", acknowledgedAt: timestamp } };
      }),
      updatedAt: timestamp,
    }));
    return this.requireEvent(contextId, eventId);
  }

  async answerQuestion(contextId: string, eventId: string, content: string): Promise<void> {
    const context = await this.requireContext(contextId);
    const event = context.events.find((candidate) => candidate.eventId === eventId);
    if (!event || event.kind !== "question") throw new Error(`Unknown child question: ${eventId}`);
    if (isQuestionAnswered(event)) throw new Error(`Child question ${eventId} is already answered.`);
    const message = boundedText(content, 16_000, "question response");
    const timestamp = this.now();
    await this.store.update(contextId, (current) => ({
      ...current,
      execution: current.execution.phase === "awaiting_parent"
        ? {
            phase: "running",
            cycleId: current.execution.cycleId,
            startedAt: current.execution.startedAt,
            sessionId: current.execution.sessionId,
            sessionFile: current.execution.sessionFile,
          }
        : current.execution,
      events: current.events.map((candidate) => candidate.eventId === eventId
        ? { ...candidate, payload: { ...(candidate.payload as Record<string, unknown>), answeredAt: timestamp } }
        : candidate),
      updatedAt: timestamp,
    }));
    await this.coordinator.message(contextId, {
      customType: "pi-tai-parent-message-v1",
      content: `Parent response: ${message}`,
      details: { kind: "question_response", questionEventId: eventId, content: message },
      delivery: "steer",
      triggerTurn: true,
    });
  }

  async unacknowledgedTerminalChildren(rootSessionId: string, parentContextId?: string): Promise<PersistedChildContextV4[]> {
    return (await this.store.listChildren(rootSessionId, parentContextId)).filter((context) => {
      if (!["completed", "blocked", "failed", "cancelled"].includes(context.execution.phase)) return true;
      const terminalId = "terminalEventId" in context.execution ? context.execution.terminalEventId : undefined;
      return !terminalId || context.events.find((event) => event.eventId === terminalId)?.delivery.phase !== "acknowledged";
    });
  }

  private async deliver(context: PersistedChildContextV4, event: PersistedChildEventV4): Promise<void> {
    const envelope = renderEnvelope(context, event);
    if (context.parentContextId) {
      await this.coordinator.message(context.parentContextId, {
        customType: "pi-tai-child-event-v1",
        content: envelope,
        details: event,
        delivery: "steer",
        triggerTurn: true,
      });
    } else {
      this.rootBridge.sendMessage({
        customType: "pi-tai-child-event-v1",
        content: envelope,
        display: false,
        details: event,
      }, { deliverAs: "steer", triggerTurn: true });
    }
    const deliveredAt = this.now();
    await this.store.update(context.contextId, (current) => ({
      ...current,
      events: current.events.map((candidate) => candidate.eventId === event.eventId && candidate.delivery.phase === "persisted"
        ? { ...candidate, delivery: { phase: "delivered", createdAt: candidate.delivery.createdAt, deliveredAt } }
        : candidate),
      updatedAt: deliveredAt,
    }));
  }

  private async requireContext(contextId: string, cycleId?: string): Promise<PersistedChildContextV4> {
    const context = await this.store.get(contextId);
    if (!context) throw new Error(`Unknown child context: ${contextId}`);
    if (cycleId && context.execution.cycleId !== cycleId) throw new Error(`Stale child execution cycle: ${cycleId}`);
    return context;
  }

  private async requireEvent(contextId: string, eventId: string): Promise<PersistedChildEventV4> {
    const event = (await this.requireContext(contextId)).events.find((candidate) => candidate.eventId === eventId);
    if (!event) throw new Error(`Unknown child event: ${eventId}`);
    return event;
  }
}

function normalizeInput(input: ChildEventInput): unknown {
  switch (input.kind) {
    case "question": return {
      question: boundedText(input.question, 8_000, "question"),
      options: boundedList(input.options, 16, 2_000, "question options"),
      ...(input.recommendation ? { recommendation: boundedText(input.recommendation, 4_000, "recommendation") } : {}),
    };
    case "status": return {
      requestId: boundedText(input.requestId, 128, "request ID"),
      summary: boundedText(input.summary, 4_000, "status summary"),
      completed: boundedList(input.completed, 32, 2_000, "completed"),
      ...(input.current ? { current: boundedText(input.current, 2_000, "current") } : {}),
      remaining: boundedList(input.remaining, 32, 2_000, "remaining"),
      blockers: boundedList(input.blockers, 16, 2_000, "blockers"),
    };
    case "terminal": return {
      outcome: input.outcome,
      summary: boundedText(input.summary, 16_000, "terminal summary"),
      validation: boundedList(input.validation, 64, 2_000, "validation"),
      changedFiles: boundedList(input.changedFiles, 256, 2_000, "changed files"),
      concerns: boundedList(input.concerns, 64, 2_000, "concerns"),
    };
    case "incident": return {
      reason: boundedText(input.reason, 8_000, "incident reason"),
      recoveryDisposition: input.recoveryDisposition,
    };
  }
}

function renderEnvelope(context: PersistedChildContextV4, event: PersistedChildEventV4): string {
  const payload = event.payload as Record<string, unknown>;
  const summary = typeof payload.summary === "string" ? payload.summary : typeof payload.question === "string" ? payload.question : typeof payload.reason === "string" ? payload.reason : event.kind;
  return `[${context.agent.name} ${context.contextId}] ${event.kind}: ${summary}`.slice(0, 16_000);
}
function isQuestionAnswered(event: PersistedChildEventV4): boolean { return Boolean((event.payload as Record<string, unknown>)?.answeredAt); }
function boundedText(value: string, bytes: number, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} must not be empty.`);
  if (Buffer.byteLength(text, "utf8") > bytes) throw new Error(`${label} exceeds ${bytes} bytes.`);
  return text;
}
function boundedList(values: readonly string[] | undefined, maxItems: number, maxBytes: number, label: string): string[] {
  if (!values) return [];
  if (values.length > maxItems) throw new Error(`${label} exceeds ${maxItems} items.`);
  return values.map((value) => boundedText(value, maxBytes, label));
}
