/**
 * Backend-neutral subagent vocabulary.
 *
 * Backends differ wildly in their native protocols — an in-process SDK session,
 * a Claude Code query stream, a Codex JSON-RPC app-server. They agree on exactly
 * one thing: they emit {@link SubagentEvent}s. The manager folds those into
 * {@link SubagentSnapshot}s, and nothing above the backend layer ever sees a
 * provider-specific message type.
 */

import type { CapabilityName } from "./capabilities.ts";

export type BackendName = "pi" | "claude" | "codex";
export type { CapabilityName } from "./capabilities.ts";

export const BACKEND_NAMES: readonly BackendName[] = ["pi", "claude", "codex"];

export type SubagentStatus = "running" | "done" | "error";

export type RunOutcome = "completed" | "failed" | "interrupted";

export interface SpawnTask {
  readonly id: string;
  /** The task itself: must stand alone, with no reliance on the parent's context. */
  readonly prompt: string;
  /** The child's charter: how to work, and what "done" means. */
  readonly systemPrompt: string;
  /** Working directory — a managed workspace path when the spawn is isolated. */
  readonly cwd: string;
  readonly title: string;
  readonly capability?: CapabilityName;
  readonly model?: string;
  readonly provider?: string;
  readonly effort?: string;
  /**
   * Tool names in pi's vocabulary. Only the pi backend can use these directly;
   * other harnesses name their tools differently and are driven by `capability`.
   */
  readonly tools?: readonly string[];
  /**
   * Opaque handle to a prior run of this subagent, when the harness can resume
   * one. Present only on a follow-up turn.
   */
  readonly resumeToken?: string;
  readonly signal?: AbortSignal;
}

export type SubagentEvent =
  | { readonly type: "run_started" }
  | { readonly type: "assistant_delta"; readonly text: string }
  | { readonly type: "assistant_message"; readonly text: string }
  | {
      readonly type: "tool_start";
      readonly toolId: string;
      readonly name: string;
      readonly preview?: string;
    }
  | {
      readonly type: "tool_end";
      readonly toolId: string;
      readonly ok: boolean;
      readonly preview?: string;
    }
  | {
      readonly type: "usage";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly contextWindow?: number;
    }
  | { readonly type: "meta"; readonly model?: string; readonly contextWindow?: number }
  | {
      readonly type: "run_settled";
      readonly outcome: RunOutcome;
      readonly text?: string;
      readonly error?: string;
    }
  | { readonly type: "backend_error"; readonly message: string };

export interface LiveTool {
  readonly name: string;
  readonly state: "running" | "done" | "error";
  readonly preview?: string;
}

export interface SubagentSnapshot {
  readonly id: string;
  readonly backend: BackendName;
  readonly title: string;
  readonly cwd: string;
  /** Set when the subagent runs in a managed workspace. */
  readonly workspaceId?: string;
  readonly status: SubagentStatus;
  readonly createdAt: string;
  readonly settledAt?: string;
  readonly errorText?: string;
  readonly model?: string;
  readonly capability?: CapabilityName;
  /** Completed assistant messages, used as a cheap progress signal. */
  readonly turns: number;
  /** Text of the last completed assistant message. */
  readonly finalText: string;
  /** Final text, or the in-flight streaming buffer when still running. */
  readonly latestText: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly contextWindow?: number;
  };
  readonly liveTools: readonly LiveTool[];
}

/** Error text is bounded so one broken child cannot flood the parent's context. */
export const MAX_ERROR_TEXT_BYTES = 4096;

export function emptySnapshot(input: {
  id: string;
  backend: BackendName;
  title: string;
  cwd: string;
  workspaceId?: string;
  capability?: CapabilityName;
  createdAt: string;
}): SubagentSnapshot {
  return {
    id: input.id,
    backend: input.backend,
    title: input.title,
    cwd: input.cwd,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.capability ? { capability: input.capability } : {}),
    status: "running",
    createdAt: input.createdAt,
    turns: 0,
    finalText: "",
    latestText: "",
    usage: { inputTokens: 0, outputTokens: 0 },
    liveTools: [],
  };
}

/**
 * Folds one event into a snapshot. Pure, so the manager's state transitions are
 * testable without spawning anything.
 */
export function applyEvent(
  snapshot: SubagentSnapshot,
  event: SubagentEvent,
  at: string,
): SubagentSnapshot {
  switch (event.type) {
    case "run_started":
      return { ...snapshot, status: "running" };
    case "assistant_delta":
      return {
        ...snapshot,
        latestText: `${snapshot.status === "running" ? snapshot.latestText : ""}${event.text}`,
      };
    case "assistant_message":
      return {
        ...snapshot,
        turns: snapshot.turns + 1,
        finalText: event.text,
        latestText: event.text,
      };
    case "tool_start":
      return {
        ...snapshot,
        liveTools: (
          [
            ...snapshot.liveTools.filter(
              (tool) => tool.name !== event.name || tool.state !== "running",
            ),
            {
              name: event.name,
              state: "running",
              ...(event.preview ? { preview: event.preview } : {}),
            },
          ] satisfies LiveTool[]
        ).slice(-8),
      };
    case "tool_end": {
      const state: LiveTool["state"] = event.ok ? "done" : "error";
      return {
        ...snapshot,
        liveTools: snapshot.liveTools.map(
          (tool, index, all): LiveTool =>
            index === all.length - 1 && tool.state === "running"
              ? { ...tool, state, ...(event.preview ? { preview: event.preview } : {}) }
              : tool,
        ),
      };
    }
    case "usage":
      return {
        ...snapshot,
        usage: {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          ...((event.contextWindow ?? snapshot.usage.contextWindow)
            ? { contextWindow: event.contextWindow ?? snapshot.usage.contextWindow }
            : {}),
        },
      };
    case "meta":
      return {
        ...snapshot,
        ...(event.model ? { model: event.model } : {}),
        ...(event.contextWindow
          ? { usage: { ...snapshot.usage, contextWindow: event.contextWindow } }
          : {}),
      };
    case "run_settled": {
      const failed = event.outcome !== "completed";
      return {
        ...snapshot,
        status: failed ? "error" : "done",
        settledAt: at,
        ...(event.text ? { finalText: event.text, latestText: event.text } : {}),
        ...(failed
          ? {
              errorText: bound(
                event.error ??
                  (event.outcome === "interrupted" ? "Run was aborted." : "Run failed."),
              ),
            }
          : {}),
        liveTools: [],
      };
    }
    case "backend_error":
      return {
        ...snapshot,
        status: "error",
        settledAt: at,
        errorText: bound(event.message),
        liveTools: [],
      };
  }
}

export function contextUtilisation(snapshot: SubagentSnapshot): number | undefined {
  const window = snapshot.usage.contextWindow;
  if (!window) return undefined;
  return Math.min(
    100,
    Math.round(((snapshot.usage.inputTokens + snapshot.usage.outputTokens) / window) * 100),
  );
}

function bound(value: string): string {
  return Buffer.byteLength(value, "utf8") <= MAX_ERROR_TEXT_BYTES
    ? value
    : `${Buffer.from(value, "utf8").subarray(0, MAX_ERROR_TEXT_BYTES).toString("utf8")}…`;
}
