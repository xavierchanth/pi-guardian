import {
  EventChannel,
  type AvailabilityResult,
  type SubagentBackend,
  type SubagentSession,
} from "../backend.ts";
import type { BackendName, SpawnTask, SubagentEvent } from "../domain.ts";
import { ClaudeInputQueue } from "./claude-input-queue.ts";

/**
 * Opt-in backend running children on the Claude Agent SDK.
 *
 * The SDK is imported dynamically and is not a declared dependency: a user who
 * never enables this backend never installs it, and `available()` reports the
 * missing package instead of crashing the extension at load time.
 *
 * Isolation comes from `cwd` alone — the SDK has no notion of managed
 * workspaces, which is exactly why the isolation layer stayed separate.
 */
export interface ClaudeBackendOptions {
  readonly defaultModel?: string;
  /**
   * Permission handling for the child. A subagent working inside its own
   * managed workspace has isolation as its safety boundary, so the default
   * skips per-tool prompts that nobody is present to answer.
   */
  readonly permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  readonly allowedTools?: readonly string[];
  readonly maxTurns?: number;
  /** Injection point for tests; defaults to importing the real SDK. */
  readonly load?: () => Promise<ClaudeSdk>;
}

/** The slice of `@anthropic-ai/claude-agent-sdk` this backend uses. */
export interface ClaudeSdk {
  query(input: {
    prompt: string | AsyncIterable<unknown>;
    options?: Record<string, unknown>;
  }): ClaudeQuery;
}

export interface ClaudeQuery extends AsyncIterable<unknown> {
  interrupt?(): Promise<unknown>;
  close?(): void;
}

/** Claude's own subagent tools, which would escape this manager's accounting. */
const NESTED_DELEGATION_TOOLS = ["Agent", "Task"] as const;

export class ClaudeBackend implements SubagentBackend {
  readonly name: BackendName = "claude";
  // Steering needs the SDK's streaming-input mode, which this backend does not
  // use: a subagent gets one self-contained task rather than a conversation.
  // Steering needs streaming-input mode; resuming does not, and a fresh run per
  // turn keeps no process alive between them.
  readonly capabilities = {
    liveInput: ["followUp"] as const,
    settledContinuation: "respawn" as const,
    modelSelection: true,
    reasoningEffort: false,
  };
  private readonly options: ClaudeBackendOptions;
  private readonly load: () => Promise<ClaudeSdk>;

  constructor(options: ClaudeBackendOptions = {}) {
    this.options = options;
    this.load = options.load ?? defaultLoad;
  }

  async available(): Promise<AvailabilityResult> {
    try {
      await this.load();
    } catch (error) {
      return {
        ok: false,
        reason:
          `@anthropic-ai/claude-agent-sdk is not installed (${error instanceof Error ? error.message : String(error)}). ` +
          "Install it to enable the claude backend.",
      };
    }
    // Credentials are deliberately not checked here. The SDK resolves them from
    // an API key, an auth token, or an OAuth profile on disk, and probing only
    // the environment would report a working Claude Code login as unavailable.
    // An auth failure surfaces as a run error carrying the SDK's own message.
    return { ok: true };
  }

  async spawn(task: SpawnTask): Promise<SubagentSession> {
    const sdk = await this.load();
    const abort = new AbortController();
    if (task.signal) task.signal.addEventListener("abort", () => abort.abort(), { once: true });
    const input = new ClaudeInputQueue();
    input.push(task.prompt);
    const query = sdk.query({
      prompt: input,
      options: {
        cwd: task.cwd,
        systemPrompt: task.systemPrompt,
        // Our children are leaves; Claude's own delegation tools would open a
        // second, unmanaged hierarchy underneath this one.
        disallowedTools: [...NESTED_DELEGATION_TOOLS],
        // A prompt nobody can answer would hang the child. The subagent's own
        // checkout is the boundary, so it works without interactive approval.
        permissionMode: this.options.permissionMode ?? "bypassPermissions",
        abortController: abort,
        ...((task.model ?? this.options.defaultModel)
          ? { model: task.model ?? this.options.defaultModel }
          : {}),
        ...(this.options.allowedTools ? { allowedTools: [...this.options.allowedTools] } : {}),
        ...(this.options.maxTurns ? { maxTurns: this.options.maxTurns } : {}),
        // Continues the prior conversation with its context intact.
        ...(task.resumeToken ? { resume: task.resumeToken } : {}),
      },
    });
    return new ClaudeSubagentSession(query, abort, input);
  }
}

class ClaudeSubagentSession implements SubagentSession {
  readonly events: AsyncIterable<SubagentEvent>;
  /** The SDK's session id, learned from the init message. */
  resumeToken?: string;
  private readonly handleListeners = new Set<(handle: string) => void>();
  onResumeHandle(callback: (handle: string) => void): () => void {
    this.handleListeners.add(callback);
    if (this.resumeToken) callback(this.resumeToken);
    return () => this.handleListeners.delete(callback);
  }
  private readonly query: ClaudeQuery;
  private readonly abort: AbortController;
  private readonly input: ClaudeInputQueue;
  private readonly channel = new EventChannel();
  private lastAssistantText = "";
  private result?: Extract<SubagentEvent, { type: "run_settled" }>;
  private settled = false;
  private queryClosed = false;

  constructor(query: ClaudeQuery, abort: AbortController, input: ClaudeInputQueue) {
    this.query = query;
    this.abort = abort;
    this.input = input;
    this.events = this.channel.events;
    this.channel.push({ type: "run_started" });
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      const iterator = this.query[Symbol.asyncIterator]();
      let drainDeadline: number | undefined;
      while (true) {
        const next = drainDeadline
          ? await nextBeforeDrainDeadline(iterator, drainDeadline)
          : await iterator.next();
        if (next.done) break;
        const message = next.value;
        const frame = message as {
          session_id?: unknown;
          type?: unknown;
          user_message_uuid?: unknown;
        };
        if (typeof frame.session_id === "string" && frame.session_id && frame.session_id !== this.resumeToken) {
          this.resumeToken = frame.session_id;
          for (const listener of this.handleListeners) listener(frame.session_id);
        }
        if (frame.type === "result") {
          this.result = translate(message).find(
            (event): event is Extract<SubagentEvent, { type: "run_settled" }> =>
              event.type === "run_settled",
          );
          const uuid =
            typeof frame.user_message_uuid === "string" ? frame.user_message_uuid : undefined;
          if (this.input.pending === 0 && (!uuid || uuid === this.input.lastYieldedUuid)) {
            this.input.close();
            drainDeadline ??= Date.now() + CLAUDE_DRAIN_TIMEOUT_MS;
          }
          continue;
        }
        for (const event of translate(message)) {
          if (event.type === "assistant_message") this.lastAssistantText = event.text;
          this.channel.push(event);
        }
      }
      if (this.abort.signal.aborted) this.settle("interrupted");
      else if (this.result && this.input.isClosed) {
        this.settled = true;
        this.channel.push(this.result);
      } else if (this.result) {
        // The SDK ended while streaming input was still accepted. Reporting its
        // earlier result would silently discard guidance that may already have
        // been yielded to the SDK.
        throw new Error("Claude ended its stream before accepting all queued input.");
      } else this.settle("completed");
    } catch (error) {
      this.input.failAll("closed");
      this.channel.push({
        type: "run_settled",
        outcome: this.abort.signal.aborted ? "interrupted" : "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      this.settled = true;
    } finally {
      // Once output ends there is no consumer capable of delivering more input.
      this.input.failAll("closed");
      this.closeQuery();
    }
  }

  private settle(outcome: "completed" | "interrupted"): void {
    if (this.settled) return;
    this.settled = true;
    this.channel.push({
      type: "run_settled",
      outcome,
      ...(outcome === "completed" ? { text: this.lastAssistantText } : {}),
    });
  }

  async send(text: string, mode: "steer" | "followUp" | "continue"): Promise<void> {
    if (mode !== "followUp") throw new Error("Claude only supports queued follow-up input.");
    this.input.push(text);
  }

  async interrupt(): Promise<void> {
    this.abort.abort();
    this.input.failAll("closed");
    await this.query.interrupt?.().catch(() => {});
  }

  dispose(): void {
    this.abort.abort();
    this.input.failAll("closed");
    this.closeQuery();
    this.channel.close();
  }

  private closeQuery(): void {
    if (this.queryClosed) return;
    this.queryClosed = true;
    try {
      this.query.close?.();
    } catch {
      // Closing is best-effort and must not replace the run's terminal event.
    }
  }
}

/**
 * Maps one SDK message to zero or more neutral events.
 *
 * Written against the message shape defensively: the SDK nests the API message
 * under `message` on some versions and inlines `content` on others, and this
 * backend must not break when a user upgrades the package.
 */
function translate(message: unknown): SubagentEvent[] {
  if (!message || typeof message !== "object") return [];
  const frame = message as {
    type?: string;
    subtype?: string;
    model?: string;
    is_error?: boolean;
    result?: unknown;
    message?: { content?: unknown; usage?: Record<string, number>; model?: string };
    content?: unknown;
    usage?: Record<string, number>;
  };
  const events: SubagentEvent[] = [];
  switch (frame.type) {
    case "system": {
      const model = frame.model ?? frame.message?.model;
      if (model) events.push({ type: "meta", model });
      return events;
    }
    case "assistant": {
      const blocks = contentBlocks(frame.message?.content ?? frame.content);
      const text = blocks
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("");
      if (text) events.push({ type: "assistant_message", text });
      for (const block of blocks) {
        if (block.type !== "tool_use") continue;
        events.push({
          type: "tool_start",
          toolId: typeof block.id === "string" ? block.id : "tool",
          name: typeof block.name === "string" ? block.name : "tool",
        });
      }
      const usage = frame.message?.usage ?? frame.usage;
      if (usage) events.push(usageEvent(usage));
      return events;
    }
    case "user": {
      for (const block of contentBlocks(frame.message?.content ?? frame.content)) {
        if (block.type !== "tool_result") continue;
        events.push({
          type: "tool_end",
          toolId: typeof block.tool_use_id === "string" ? block.tool_use_id : "tool",
          ok: block.is_error !== true,
        });
      }
      return events;
    }
    case "result": {
      const failed = frame.is_error === true || (frame.subtype ?? "success") !== "success";
      const text = typeof frame.result === "string" ? frame.result : "";
      events.push(
        failed
          ? {
              type: "run_settled",
              outcome: "failed",
              error: text || `Claude run ended with ${frame.subtype ?? "an error"}.`,
            }
          : { type: "run_settled", outcome: "completed", ...(text ? { text } : {}) },
      );
      return events;
    }
    default:
      return events;
  }
}

function contentBlocks(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is Record<string, unknown> => typeof block === "object" && block !== null,
  );
}

function usageEvent(usage: Record<string, number>): SubagentEvent {
  const input =
    numeric(usage.input_tokens) +
    numeric(usage.cache_read_input_tokens) +
    numeric(usage.cache_creation_input_tokens);
  return { type: "usage", inputTokens: input, outputTokens: numeric(usage.output_tokens) };
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const CLAUDE_DRAIN_TIMEOUT_MS = 30_000;

async function nextBeforeDrainDeadline<T>(
  iterator: AsyncIterator<T>,
  deadline: number,
): Promise<IteratorResult<T>> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Claude did not end its stream after input was closed.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Claude did not end its stream after input was closed.")),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function defaultLoad(): Promise<ClaudeSdk> {
  // Indirected through a variable so bundlers treat this as a runtime import of
  // an optional dependency rather than a hard build-time edge.
  const specifier = "@anthropic-ai/claude-agent-sdk";
  return (await import(specifier)) as unknown as ClaudeSdk;
}
