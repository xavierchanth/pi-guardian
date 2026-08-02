import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  PrivateChildSessionFactory,
  type PrivateChildSessionFactoryPort,
  type PrivateChildSessionHandle,
} from "../../concurrency/child-session.ts";
import type { SessionPolicyReader } from "../../../core/config/register.ts";
import {
  EventChannel,
  type AvailabilityResult,
  SendNotDeliveredError,
  type SubagentBackend,
  type SubagentSession,
} from "../backend.ts";
import type { BackendName, SpawnTask, SubagentEvent } from "../domain.ts";

/**
 * The default backend: a child pi session running in-process.
 *
 * It reuses {@link PrivateChildSessionFactory}, which already isolates the child
 * behind its own state directory with no inherited extensions, skills, or
 * context files. The work here is purely translation — pi's session events into
 * the backend-neutral {@link SubagentEvent} stream.
 */
export interface PiBackendOptions {
  readonly config: SessionPolicyReader;
  readonly modelRegistry: ExtensionContext["modelRegistry"];
  readonly stateRoot: string;
  readonly agentDir?: string;
  /** Fallback provider/model when a spawn names neither. */
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly defaultEffort?: string;
  readonly defaultTools?: readonly string[];
  readonly extensions?: readonly InlineExtension[];
  /**
   * Per-child extensions. The tool-call policy goes here: it has to run inside
   * the child's own session, and it depends on that child's workspace.
   */
  readonly extensionsFor?: (task: SpawnTask) => readonly InlineExtension[];
  readonly factory?: PrivateChildSessionFactoryPort;
}

export class PiBackend implements SubagentBackend {
  readonly name: BackendName = "pi";
  readonly capabilities = {
    liveInput: ["steer", "followUp"] as const,
    settledContinuation: "in-place" as const,
    modelSelection: true,
    reasoningEffort: true,
  };
  private readonly options: PiBackendOptions;
  private readonly factory: PrivateChildSessionFactoryPort;

  constructor(options: PiBackendOptions) {
    this.options = options;
    this.factory = options.factory ?? new PrivateChildSessionFactory({ config: options.config });
  }

  async available(): Promise<AvailabilityResult> {
    // Each spawn names its own model, so there is nothing to verify up front.
    return { ok: true };
  }

  async spawn(task: SpawnTask): Promise<SubagentSession> {
    const handle = await this.factory.create({
      contextId: task.durableId ?? task.id,
      cwd: task.cwd,
      stateRoot: this.options.stateRoot,
      ...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}),
      agent: {
        name: task.title,
        provider: task.provider ?? this.options.defaultProvider,
        model: task.model ?? this.options.defaultModel,
        effort: (task.effort ?? this.options.defaultEffort ?? "medium") as never,
        tools: [...(task.tools ?? this.options.defaultTools ?? [])],
      } as never,
      modelRegistry: this.options.modelRegistry,
      systemPrompt: task.systemPrompt,
      extensions: [
        ...(this.options.extensions ?? []),
        ...(this.options.extensionsFor?.(task) ?? []),
      ],
      ...(task.signal ? { signal: task.signal } : {}),
    });
    return new PiSubagentSession(handle, task);
  }
}

class PiSubagentSession implements SubagentSession {
  get events(): AsyncIterable<SubagentEvent> {
    return this.active.channel.events;
  }
  readonly sessionFile: string;
  private readonly handle: PrivateChildSessionHandle;
  private active: PiRun;
  private disposed = false;

  constructor(handle: PrivateChildSessionHandle, task: SpawnTask) {
    this.handle = handle;
    this.sessionFile = handle.sessionFile;
    this.active = this.startRun(task.model, true);
    void this.run(this.active, task.prompt, task.signal);
  }

  private startRun(model?: string, emitMeta = false): PiRun {
    const run: PiRun = {
      channel: new EventChannel(),
      unsubscribe: () => {},
      streamed: 0,
      lastAssistantText: "",
      active: true,
    };
    run.unsubscribe = this.handle.session.subscribe((event) => this.translate(run, event));
    run.channel.push({ type: "run_started" });
    if (emitMeta) run.channel.push({ type: "meta", ...(model ? { model } : {}) });
    return run;
  }

  private async run(run: PiRun, text: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.handle.session.prompt(text);
      await this.handle.session.waitForIdle();
      if (!run.active) return;
      run.channel.push({
        type: "run_settled",
        outcome: signal?.aborted || this.disposed ? "interrupted" : "completed",
        text: run.lastAssistantText,
      });
    } catch (error) {
      if (!run.active) return;
      run.channel.push({
        type: "run_settled",
        outcome: this.disposed ? "interrupted" : "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // A completion may belong to an obsolete generation. It may only tear
      // down its own immutable subscription, never a successor's.
      run.unsubscribe();
    }
  }

  private translate(run: PiRun, event: unknown): void {
    if (!run.active) return;
    const frame = event as {
      type?: string;
      message?: { role?: string; usage?: Record<string, number> };
      toolName?: string;
      toolCallId?: string;
      isError?: boolean;
    };
    switch (frame.type) {
      case "message_update": {
        const partial = assistantText(frame);
        if (partial === undefined || partial.length <= run.streamed) return;
        run.channel.push({ type: "assistant_delta", text: partial.slice(run.streamed) });
        run.streamed = partial.length;
        return;
      }
      case "message_end":
      case "turn_end": {
        if (frame.message?.role !== "assistant") return;
        const text = assistantText(frame);
        run.streamed = 0;
        if (text) {
          run.lastAssistantText = text;
          run.channel.push({ type: "assistant_message", text });
        }
        const usage = frame.message.usage;
        if (usage)
          run.channel.push({
            type: "usage",
            inputTokens:
              numeric(usage.input) + numeric(usage.cacheRead) + numeric(usage.cacheWrite),
            outputTokens: numeric(usage.output),
            ...(usage.contextWindow ? { contextWindow: usage.contextWindow } : {}),
          });
        return;
      }
      case "tool_execution_start":
        run.channel.push({
          type: "tool_start",
          toolId: frame.toolCallId ?? frame.toolName ?? "tool",
          name: frame.toolName ?? "tool",
        });
        return;
      case "tool_execution_end":
        run.channel.push({
          type: "tool_end",
          toolId: frame.toolCallId ?? frame.toolName ?? "tool",
          ok: !frame.isError,
        });
        return;
      default:
        return;
    }
  }

  continueInPlace(text: string): Promise<void> {
    if (this.disposed)
      return Promise.reject(new SendNotDeliveredError("Pi child session was disposed.", "closed"));
    if (this.handle.session.isStreaming)
      return Promise.reject(
        new SendNotDeliveredError("Pi child is still streaming.", "precondition"),
      );
    const previous = this.active;
    previous.active = false;
    previous.unsubscribe();
    const run = this.startRun();
    this.active = run;
    void this.run(run, text);
    return Promise.resolve();
  }

  async send(text: string, mode: "steer" | "followUp" | "continue"): Promise<void> {
    if (mode === "continue") throw new Error("Pi does not support continuing a settled subagent.");
    if (!this.handle.session.isStreaming)
      throw new SendNotDeliveredError(
        `Pi child is no longer streaming; ${mode} was not delivered.`,
        "settled",
      );
    await this.handle.session.prompt(text, { streamingBehavior: mode });
  }

  async interrupt(): Promise<void> {
    await this.handle.abort();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active.active = false;
    this.active.unsubscribe();
    this.active.channel.close();
    this.handle.dispose();
  }
}

interface PiRun {
  readonly channel: EventChannel;
  unsubscribe: () => void;
  streamed: number;
  lastAssistantText: string;
  active: boolean;
}

function assistantText(frame: unknown): string | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const candidate = frame as {
    message?: unknown;
    assistantMessageEvent?: { type?: unknown; content?: unknown; partial?: unknown };
  };
  return (
    messageText(candidate.message) ??
    (candidate.assistantMessageEvent?.type === "text_end" &&
    typeof candidate.assistantMessageEvent.content === "string"
      ? candidate.assistantMessageEvent.content
      : undefined) ??
    messageText(candidate.assistantMessageEvent?.partial)
  );
}

function messageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
  return text || undefined;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
