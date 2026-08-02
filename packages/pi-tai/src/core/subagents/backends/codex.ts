import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface, type Interface } from "node:readline";
import {
  EventChannel,
  type AvailabilityResult,
  SendNotDeliveredError,
  type SubagentBackend,
  type SubagentSession,
} from "../backend.ts";
import type { BackendName, SpawnTask, SubagentEvent } from "../domain.ts";
import {
  researchAvailability,
  type CodexMethod,
  type CodexParams,
  type CodexResult,
} from "./codex-protocol.ts";

/**
 * Opt-in backend running children on `codex app-server`.
 *
 * The protocol is newline-delimited JSON-RPC over stdio. Method and
 * notification names below come from the app-server's own schema
 * (`codex app-server generate-json-schema`), not from guesswork; regenerate it
 * after a codex upgrade if the mapping starts to drift.
 *
 * Handshake: initialize → initialized → thread/start → turn/start, then fold
 * `turn/*` and `item/*` notifications into the neutral event stream.
 */
export interface CodexBackendOptions {
  readonly binary?: string;
  readonly defaultModel?: string;
  /** Codex's own sandbox. Managed workspaces already scope writes to one tree. */
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** "never" suits a headless child: nobody is present to answer a prompt. */
  readonly approvalPolicy?: "untrusted" | "on-request" | "never";
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly startupTimeoutMs?: number;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

export class CodexBackend implements SubagentBackend {
  readonly name: BackendName = "codex";
  // A settled thread is continued with `thread/resume`, which is what a
  // follow-up turn needs. Live steering mid-turn is not wired up.
  readonly capabilities = {
    liveInput: ["steer"] as const,
    settledContinuation: "respawn" as const,
    modelSelection: true,
    reasoningEffort: true,
  };
  private readonly options: CodexBackendOptions;

  constructor(options: CodexBackendOptions = {}) {
    this.options = options;
  }

  async available(): Promise<AvailabilityResult> {
    const binary = this.options.binary ?? "codex";
    return new Promise((resolve) => {
      const probe = spawn(binary, ["--version"], { stdio: "ignore", shell: false });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        resolve({
          ok: false,
          reason:
            error.code === "ENOENT"
              ? `The \`${binary}\` binary is not on PATH; install the Codex CLI to enable this backend.`
              : `Could not run \`${binary}\`: ${error.message}`,
        });
      });
      probe.once("close", (code) => {
        resolve(
          code === 0
            ? { ok: true }
            : { ok: false, reason: `\`${binary} --version\` exited with status ${code}.` },
        );
      });
    });
  }

  async spawn(task: SpawnTask): Promise<SubagentSession> {
    const binary = this.options.binary ?? "codex";
    const child = spawn(binary, ["app-server"], {
      cwd: task.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const session = new CodexSubagentSession(child, task, this.options);
    await session.start();
    return session;
  }
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

class CodexRpcError extends Error {
  readonly code?: number;
  readonly data?: unknown;
  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export function codexVersionAtLeast(userAgent: unknown, minimum = [0, 145, 0]): boolean {
  if (typeof userAgent !== "string") return false;
  const match = /^[A-Za-z0-9_-]+\/(\d+)\.(\d+)\.(\d+)/.exec(userAgent);
  if (!match) return false;
  const version = match.slice(1).map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (version[i]! > minimum[i]!) return true;
    if (version[i]! < minimum[i]!) return false;
  }
  return true;
}

class CodexSubagentSession implements SubagentSession {
  readonly events: AsyncIterable<SubagentEvent>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly task: SpawnTask;
  private readonly options: CodexBackendOptions;
  private readonly channel = new EventChannel();
  private readonly pending = new Map<number, Pending>();
  private readonly lines: Interface;
  private nextId = 1;
  private threadId?: string;
  /** The thread id, which is how a settled subagent is continued. */
  get resumeToken(): string | undefined {
    return this.threadId;
  }
  private turnId?: string;
  private steerEnabled = false;
  get liveInput(): readonly "steer"[] | readonly [] {
    return this.steerEnabled ? ["steer"] : [];
  }
  private lastAssistantText = "";
  private disposed = false;

  constructor(
    child: ChildProcessWithoutNullStreams,
    task: SpawnTask,
    options: CodexBackendOptions,
  ) {
    this.child = child;
    this.task = task;
    this.options = options;
    this.events = this.channel.events;
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.receive(line));
    child.once("error", (error) => this.fail(`Failed to start codex: ${error.message}`));
    child.once("close", (code) => {
      // A clean exit after settling is expected; anything else is a fault.
      this.fail(`codex app-server exited with status ${code ?? "unknown"}.`);
    });
    task.signal?.addEventListener("abort", () => void this.interrupt(), { once: true });
  }

  /** Runs the handshake and starts the first turn. Rejects if codex never comes up. */
  async start(): Promise<void> {
    try {
      const initialized = await this.request("initialize", {
        clientInfo: {
          name: this.options.clientName ?? "pi-tai",
          version: this.options.clientVersion ?? "0.1.0",
        },
      });
      this.steerEnabled = codexVersionAtLeast(initialized.userAgent);
      this.notify("initialized", {});
      if (this.task.capability === "researcher") {
        const [capabilities, requirements] = await Promise.all([
          this.request("modelProvider/capabilities/read", {}),
          this.request("configRequirements/read", {}),
        ]);
        const availability = researchAvailability(capabilities, requirements);
        if (!availability.ok) throw new Error(`Researcher unavailable: ${availability.reason}`);
      }
      // A resume token is a thread id: continuing a finished subagent is the
      // same conversation, not a new one that has to be re-briefed.
      const thread = this.task.resumeToken
        ? await this.request("thread/resume", { threadId: this.task.resumeToken })
        : await this.request("thread/start", {
            cwd: this.task.cwd,
            developerInstructions: this.task.systemPrompt,
            // Nobody is present to answer an approval prompt, so they are off; the
            // child works in its own directory like on any other harness.
            approvalPolicy: this.options.approvalPolicy ?? "never",
            sandbox: this.options.sandbox ?? "workspace-write",
            // Research is truthful only when app-server itself is put in live mode.
            ...(this.task.capability === "researcher" ? { config: { web_search: "live" } } : {}),
            ...((this.task.model ?? this.options.defaultModel)
              ? { model: this.task.model ?? this.options.defaultModel }
              : {}),
          });
      this.threadId = threadIdOf(thread) ?? this.task.resumeToken;
      if (!this.threadId) throw new Error("codex thread/start returned no thread id.");
      this.channel.push({ type: "run_started" });
      if (this.task.model ?? this.options.defaultModel) {
        this.channel.push({ type: "meta", model: (this.task.model ?? this.options.defaultModel)! });
      }
      await this.request("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text: this.task.prompt }],
        ...(this.task.effort ? { effort: this.task.effort } : {}),
        ...((this.task.model ?? this.options.defaultModel)
          ? { model: this.task.model ?? this.options.defaultModel }
          : {}),
      });
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private receive(line: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // Non-JSON chatter on stdout is not protocol traffic.
    }
    const id = frame.id;
    if (typeof id === "number" && this.pending.has(id)) {
      const waiter = this.pending.get(id)!;
      this.pending.delete(id);
      const error = frame.error as { message?: string; code?: number; data?: unknown } | undefined;
      if (error)
        waiter.reject(
          new CodexRpcError(error.message ?? "codex returned an error.", error.code, error.data),
        );
      else waiter.resolve((frame.result ?? {}) as Record<string, unknown>);
      return;
    }
    if (typeof frame.method !== "string") return;
    // Server→client *requests* carry an id and must be answered; notifications do not.
    if (typeof id === "number" || typeof id === "string") {
      this.answerApproval(id, frame.method);
      return;
    }
    this.handleNotification(frame.method, (frame.params ?? {}) as Record<string, unknown>);
  }

  /**
   * Codex still asks in a few situations even under `approvalPolicy: "never"`.
   * A headless child cannot answer, so decline: its sandbox already bounds it,
   * and a silent approval here would widen that boundary.
   */
  private answerApproval(id: number | string, method: string): void {
    if (!/approval/i.test(method)) return;
    this.write({ id, result: { decision: "denied" } });
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "turn/started": {
        this.turnId = idOf(params.turn);
        return;
      }
      case "item/agentMessage/delta": {
        if (typeof params.delta === "string")
          this.channel.push({ type: "assistant_delta", text: params.delta });
        return;
      }
      case "item/started":
      case "item/completed": {
        const item = params.item as Record<string, unknown> | undefined;
        if (!item) return;
        if (item.type === "agentMessage" && method === "item/completed") {
          const text = typeof item.text === "string" ? item.text : "";
          if (text) {
            this.lastAssistantText = text;
            this.channel.push({ type: "assistant_message", text });
          }
          return;
        }
        if (item.type === "webSearch") {
          const toolId = typeof item.id === "string" ? item.id : "webSearch";
          const query = typeof item.query === "string" ? item.query : undefined;
          this.channel.push(
            method === "item/started"
              ? {
                  type: "tool_start",
                  toolId,
                  name: "web_search",
                  ...(query ? { preview: query } : {}),
                }
              : { type: "tool_end", toolId, ok: true, ...(query ? { preview: query } : {}) },
          );
          return;
        }
        if (
          item.type === "commandExecution" ||
          item.type === "mcpToolCall" ||
          item.type === "fileChange"
        ) {
          const toolId = typeof item.id === "string" ? item.id : String(item.type);
          if (method === "item/started") {
            this.channel.push({
              type: "tool_start",
              toolId,
              name: String(item.type),
              ...(typeof item.command === "string" ? { preview: item.command } : {}),
            });
          } else {
            this.channel.push({ type: "tool_end", toolId, ok: item.status !== "failed" });
          }
        }
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = params.tokenUsage as Record<string, unknown> | undefined;
        const total = usage?.total as Record<string, number> | undefined;
        if (!total) return;
        this.channel.push({
          type: "usage",
          inputTokens: numeric(total.inputTokens) + numeric(total.cachedInputTokens),
          outputTokens: numeric(total.outputTokens),
          ...(numeric(usage?.modelContextWindow)
            ? { contextWindow: numeric(usage?.modelContextWindow) }
            : {}),
        });
        return;
      }
      case "turn/completed": {
        this.turnId = undefined;
        const turn = params.turn as Record<string, unknown> | undefined;
        const status = turn?.status;
        const error = turn?.error as { message?: string } | undefined;
        this.channel.push(
          status === "completed"
            ? { type: "run_settled", outcome: "completed", text: this.lastAssistantText }
            : status === "interrupted"
              ? { type: "run_settled", outcome: "interrupted" }
              : {
                  type: "run_settled",
                  outcome: "failed",
                  error: error?.message ?? "codex turn failed.",
                },
        );
        this.cleanup();
        return;
      }
      case "error": {
        const error = params.error as { message?: string } | undefined;
        // `willRetry` errors are transient; codex recovers on its own.
        if (params.willRetry === true) return;
        this.channel.push({
          type: "run_settled",
          outcome: "failed",
          error: error?.message ?? "codex reported an error.",
        });
        this.cleanup();
        return;
      }
      default:
        return;
    }
  }

  async send(text: string, mode: "steer" | "followUp" | "continue"): Promise<void> {
    if (mode !== "steer" || !this.steerEnabled)
      throw new SendNotDeliveredError("Codex steering is unavailable for this session.", "precondition");
    if (!this.threadId || !this.turnId)
      throw new SendNotDeliveredError("Codex has no active turn to steer.", "precondition");
    try {
      await this.request("turn/steer", {
        threadId: this.threadId,
        expectedTurnId: this.turnId,
        input: [{ type: "text", text }],
        clientUserMessageId: randomUUID(),
      });
    } catch (error) {
      if (!(error instanceof CodexRpcError)) throw error;
      if (error.code === -32601) {
        this.steerEnabled = false;
        throw new SendNotDeliveredError("Codex app-server does not support turn/steer.", "precondition");
      }
      if (error.code === -32600) {
        const info = (error.data as { codex_error_info?: Record<string, unknown> } | undefined)
          ?.codex_error_info;
        if (info?.ActiveTurnNotSteerable !== undefined) {
          this.steerEnabled = false;
          throw new SendNotDeliveredError("The active Codex turn is not steerable.", "precondition");
        }
        throw new SendNotDeliveredError("The Codex turn settled before steering.", "settled");
      }
      throw error;
    }
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.turnId) {
      this.channel.push({ type: "run_settled", outcome: "interrupted" });
      this.cleanup();
      return;
    }
    try {
      await this.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
    } catch {
      // Codex may already have settled the turn; the manager settles us either way.
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lines.close();
    this.child.kill("SIGTERM");
    for (const waiter of this.pending.values())
      waiter.reject(new Error("codex session was disposed."));
    this.pending.clear();
    this.channel.close();
  }

  private cleanup(): void {
    this.lines.close();
    this.child.kill("SIGTERM");
    this.disposed = true;
  }

  private fail(message: string): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const waiter of this.pending.values()) waiter.reject(new Error(message));
    this.pending.clear();
    this.channel.push({ type: "backend_error", message });
  }

  private request<M extends CodexMethod>(
    method: M,
    params: CodexParams<M>,
  ): Promise<CodexResult<M>> {
    const id = this.nextId++;
    const timeoutMs = this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex ${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as CodexResult<M>);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.write({ id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private write(frame: unknown): void {
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }
}

function threadIdOf(result: Record<string, unknown>): string | undefined {
  const thread = result.thread as Record<string, unknown> | undefined;
  return idOf(thread) ?? (typeof result.threadId === "string" ? result.threadId : undefined);
}

function idOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
