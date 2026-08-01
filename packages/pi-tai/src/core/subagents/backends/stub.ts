import {
  EventChannel,
  type AvailabilityResult,
  type SubagentBackend,
  type SubagentSession,
} from "../backend.ts";
import type { BackendName, SpawnTask, SubagentEvent } from "../domain.ts";

/**
 * A backend that emits a scripted event sequence. Used by tests to exercise the
 * manager, delivery and tool layers without spawning a model.
 *
 * Conventions: a prompt starting with `FAIL:` settles as failed, one starting
 * with `HANG:` never settles on its own (so cancellation can be tested).
 */
export interface StubBackendOptions {
  readonly name?: BackendName;
  readonly available?: AvailabilityResult;
  /** Overrides the default script entirely. */
  readonly script?: (task: SpawnTask) => readonly SubagentEvent[];
}

export class StubBackend implements SubagentBackend {
  readonly name: BackendName;
  readonly capabilities = {
    liveInput: ["steer", "followUp"] as const,
    settledContinuation: "respawn" as const,
    modelSelection: true,
    reasoningEffort: true,
  };
  readonly spawned: SpawnTask[] = [];
  readonly sends: { text: string; mode: "steer" | "followUp" | "continue" }[] = [];
  private readonly availability: AvailabilityResult;
  private readonly script?: (task: SpawnTask) => readonly SubagentEvent[];

  constructor(options: StubBackendOptions = {}) {
    this.name = options.name ?? "pi";
    this.availability = options.available ?? { ok: true };
    if (options.script) this.script = options.script;
  }

  async available(): Promise<AvailabilityResult> {
    return this.availability;
  }

  async spawn(task: SpawnTask): Promise<SubagentSession> {
    this.spawned.push(task);
    const channel = new EventChannel();
    const sends = this.sends;
    const session: SubagentSession = {
      events: channel.events,
      resumeToken: `stub-session-${task.id}`,
      async send(text, mode) {
        sends.push({ text, mode });
        channel.push({ type: "assistant_message", text: `${mode}: ${text}` });
      },
      async interrupt() {
        channel.push({ type: "run_settled", outcome: "interrupted" });
      },
      dispose() {
        channel.close();
      },
    };
    for (const event of this.script?.(task) ?? defaultScript(task)) channel.push(event);
    return session;
  }
}

function defaultScript(task: SpawnTask): SubagentEvent[] {
  const events: SubagentEvent[] = [
    { type: "run_started" },
    { type: "meta", model: task.model ?? "stub-model", contextWindow: 200_000 },
    { type: "usage", inputTokens: 1_000, outputTokens: 250, contextWindow: 200_000 },
  ];
  if (task.prompt.startsWith("HANG:")) return events;
  if (task.prompt.startsWith("FAIL:")) {
    return [
      ...events,
      { type: "run_settled", outcome: "failed", error: task.prompt.slice("FAIL:".length).trim() },
    ];
  }
  const text = `done: ${task.prompt}`;
  return [
    ...events,
    { type: "tool_start", toolId: "t1", name: "bash", preview: "ls" },
    { type: "tool_end", toolId: "t1", ok: true, preview: "ok" },
    { type: "assistant_message", text },
    { type: "run_settled", outcome: "completed", text },
  ];
}
