import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ModelInfo,
  RuntimeCapabilities,
  SessionCreateParams,
  SessionInfo,
  SessionOpenParams,
  SessionPromptParams,
  SessionSetModelParams,
  SessionSetThinkingParams,
  SessionTextParams,
  ThinkingInfo,
} from "@pi-tai/runtime-protocol";
import type { PromptStart, RuntimeEventSink, RuntimePort } from "./runtime-port.ts";

export class FakeRuntimePort implements RuntimePort {
  private session?: SessionInfo;
  private active?: { turnId: string; controller: AbortController };
  private model: ModelInfo = { provider: "faux", model: "scripted" };
  private thinking: ThinkingInfo = { level: "off" };

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      methods: [],
      tools: ["update_plan"],
      commands: ["continue", "plan-status"],
      extensionErrors: [],
    };
  }

  async createSession(params: SessionCreateParams, emit: RuntimeEventSink): Promise<SessionInfo> {
    await this.disposeSession();
    await mkdir(params.sessionDir, { recursive: true });
    const sessionId = randomUUID();
    const sessionFile = join(params.sessionDir, `${sessionId}.jsonl`);
    await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: params.cwd })}\n`);
    this.session = { sessionId, sessionFile, cwd: params.cwd };
    emit({ event: "session.ready", data: this.session, sessionId });
    return this.session;
  }

  async openSession(params: SessionOpenParams, emit: RuntimeEventSink): Promise<SessionInfo> {
    await this.disposeSession();
    const firstLine = (await import("node:fs/promises")).readFile(params.sessionFile, "utf8")
      .then((contents) => contents.split("\n", 1)[0]);
    const header = JSON.parse(await firstLine) as { id?: unknown; cwd?: unknown };
    if (typeof header.id !== "string" || typeof header.cwd !== "string") {
      throw new Error("Session header is invalid.");
    }
    this.session = { sessionId: header.id, sessionFile: params.sessionFile, cwd: header.cwd };
    emit({ event: "session.replaced", data: this.session, sessionId: this.session.sessionId });
    return this.session;
  }

  async startPrompt(
    params: SessionPromptParams,
    commandId: string,
    emit: RuntimeEventSink,
  ): Promise<PromptStart> {
    if (!this.session) throw new Error("No session is loaded.");
    if (this.active) throw new Error("A turn is already active.");
    const controller = new AbortController();
    this.active = { turnId: params.turnId, controller };
    const session = this.session;
    const completion = this.runPrompt(session, params, commandId, controller.signal, emit)
      .finally(() => {
        if (this.active?.turnId === params.turnId) this.active = undefined;
      });
    return { accepted: true, completion };
  }

  async steer(_params: SessionTextParams): Promise<boolean> {
    return Boolean(this.active);
  }

  async followUp(_params: SessionTextParams): Promise<boolean> {
    return Boolean(this.active);
  }

  async cancel(turnId: string): Promise<boolean> {
    if (!this.active || this.active.turnId !== turnId) return false;
    this.active.controller.abort();
    return true;
  }

  async setModel(params: SessionSetModelParams): Promise<ModelInfo> {
    this.model = { provider: params.provider, model: params.model };
    return this.model;
  }

  async setThinking(params: SessionSetThinkingParams): Promise<ThinkingInfo> {
    this.thinking = { level: params.level };
    return this.thinking;
  }

  async disposeSession(): Promise<void> {
    if (this.active) {
      this.active.controller.abort();
      this.active = undefined;
    }
    this.session = undefined;
  }

  async shutdown(): Promise<void> {
    await this.disposeSession();
  }

  private async runPrompt(
    session: SessionInfo,
    params: SessionPromptParams,
    commandId: string,
    signal: AbortSignal,
    emit: RuntimeEventSink,
  ): Promise<void> {
    const base = { commandId, sessionId: session.sessionId, turnId: params.turnId };
    emit({ ...base, event: "agent.start", data: {} });
    emit({ ...base, event: "turn.start", data: {} });
    const chunks = params.text.includes("slow") ? ["slow", " response"] : ["faux", " response"];
    for (const delta of chunks) {
      await wait(params.text.includes("slow") ? 100 : 1, signal);
      emit({ ...base, event: "assistant.text_delta", data: { delta } });
    }
    emit({ ...base, event: "turn.end", data: {} });
    emit({ ...base, event: "agent.end", data: {} });
    emit({ ...base, event: "session.idle", data: {} });
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new Error("Turn cancelled."));
    }, { once: true });
  });
}
