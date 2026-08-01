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
  readonly capabilities = { steering: true, modelSelection: true, reasoningEffort: true };
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
  readonly events: AsyncIterable<SubagentEvent>;
  readonly sessionFile: string;
  private readonly handle: PrivateChildSessionHandle;
  private readonly channel = new EventChannel();
  private readonly unsubscribe: () => void;
  /** Length of the streaming text already emitted, so deltas stay incremental. */
  private streamed = 0;
  private lastAssistantText = "";
  private disposed = false;

  constructor(handle: PrivateChildSessionHandle, task: SpawnTask) {
    this.handle = handle;
    this.sessionFile = handle.sessionFile;
    this.events = this.channel.events;
    this.unsubscribe = handle.session.subscribe((event) => this.translate(event));
    this.channel.push({ type: "run_started" });
    this.channel.push({
      type: "meta",
      ...(task.model ? { model: task.model } : {}),
    });
    void this.run(task);
  }

  private async run(task: SpawnTask): Promise<void> {
    try {
      await this.handle.session.prompt(task.prompt);
      await this.handle.session.waitForIdle();
      this.channel.push({
        type: "run_settled",
        outcome: task.signal?.aborted ? "interrupted" : "completed",
        text: this.lastAssistantText,
      });
    } catch (error) {
      this.channel.push({
        type: "run_settled",
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.unsubscribe();
    }
  }

  private translate(event: unknown): void {
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
        if (partial === undefined || partial.length <= this.streamed) return;
        this.channel.push({ type: "assistant_delta", text: partial.slice(this.streamed) });
        this.streamed = partial.length;
        return;
      }
      case "message_end":
      case "turn_end": {
        if (frame.message?.role !== "assistant") return;
        const text = assistantText(frame);
        this.streamed = 0;
        if (text) {
          this.lastAssistantText = text;
          this.channel.push({ type: "assistant_message", text });
        }
        const usage = frame.message.usage;
        if (usage) {
          this.channel.push({
            type: "usage",
            inputTokens:
              numeric(usage.input) + numeric(usage.cacheRead) + numeric(usage.cacheWrite),
            outputTokens: numeric(usage.output),
            ...(usage.contextWindow ? { contextWindow: usage.contextWindow } : {}),
          });
        }
        return;
      }
      case "tool_execution_start":
        this.channel.push({
          type: "tool_start",
          toolId: frame.toolCallId ?? frame.toolName ?? "tool",
          name: frame.toolName ?? "tool",
        });
        return;
      case "tool_execution_end":
        this.channel.push({
          type: "tool_end",
          toolId: frame.toolCallId ?? frame.toolName ?? "tool",
          ok: !frame.isError,
        });
        return;
      default:
        return;
    }
  }

  async send(text: string): Promise<void> {
    // Never rely on AgentSession's default while a turn is active: this input
    // must steer the current turn rather than being ambiguously queued.
    await this.handle.session.prompt(text, { streamingBehavior: "steer" });
  }

  async interrupt(): Promise<void> {
    await this.handle.abort();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.channel.close();
    this.handle.dispose();
  }
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
