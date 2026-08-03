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
  SessionRelocateWorkspaceParams,
  SessionSetModelParams,
  SessionSetThinkingParams,
  SessionTextParams,
  ThinkingInfo,
} from "@pi-tai/runtime-protocol";
import type { HostServicePort } from "./host-services.ts";
import type { PromptStart, RuntimeEventSink, RuntimePort } from "./runtime-port.ts";

export class FakeRuntimePort implements RuntimePort {
  private session?: SessionInfo;
  private active?: { turnId: string; controller: AbortController };
  private model: ModelInfo = { provider: "faux", model: "scripted" };
  private thinking: ThinkingInfo = { level: "off" };
  private hostServices?: HostServicePort;

  bindHostServices(services: HostServicePort): void {
    this.hostServices = services;
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      methods: [],
      tools: [],
      commands: ["continue"],
      extensionErrors: [],
    };
  }

  async createSession(params: SessionCreateParams, emit: RuntimeEventSink): Promise<SessionInfo> {
    await this.disposeSession();
    await mkdir(params.sessionDir, { recursive: true });
    const sessionId = randomUUID();
    const sessionFile = join(params.sessionDir, `${sessionId}.jsonl`);
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: params.cwd })}\n`,
    );
    this.session = { sessionId, sessionFile, cwd: params.cwd };
    emit({ event: "session.ready", data: this.session, sessionId });
    return this.session;
  }

  async openSession(params: SessionOpenParams, emit: RuntimeEventSink): Promise<SessionInfo> {
    await this.disposeSession();
    const firstLine = (await import("node:fs/promises"))
      .readFile(params.sessionFile, "utf8")
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
    const completion = this.runPrompt(session, params, commandId, controller.signal, emit).finally(
      () => {
        if (this.active?.turnId === params.turnId) this.active = undefined;
      },
    );
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

  async relocateWorkspace(
    params: SessionRelocateWorkspaceParams,
    emit: RuntimeEventSink,
  ): Promise<SessionInfo> {
    if (!this.session) throw new Error("No session is loaded.");
    this.session = { ...this.session, cwd: join(this.session.cwd, params.name) };
    emit({ event: "session.replaced", sessionId: this.session.sessionId, data: this.session });
    return this.session;
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
    if (params.text.includes("host-service")) {
      if (!this.hostServices) throw new Error("Host services are unavailable.");
      await this.hostServices.request("core.transact", {
        transactionId: `transaction-${params.turnId}`,
        expectedRevision: 0,
        events: [
          {
            eventId: `event-${params.turnId}`,
            type: "test.recorded",
            payload: { turnId: params.turnId },
          },
        ],
        state: { version: 1, contexts: [] },
        projection: {
          version: 1,
          rootSessionId: session.sessionId,
          revision: 1,
          generatedAt: "now",
          children: [],
          inactiveChildCount: 0,
          tasks: [],
          inactiveTaskCount: 0,
          workspaces: [],
          activeClaimCount: 0,
          unansweredQuestionCount: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
          telemetryGapCount: 0,
          truncated: false,
        },
      });
    }
    const chunks = params.text.includes("slow") ? ["slow", " response"] : ["faux", " response"];
    for (const delta of chunks) {
      await wait(params.text.includes("slow") ? 100 : 1, signal);
      emit({ ...base, event: "assistant.text_delta", data: { delta } });
    }
    emit({
      ...base,
      event: "message.end",
      data: {
        role: "assistant",
        messageId: `message-${params.turnId}`,
        provider: "pi-tai",
        model: "faux",
        usage: {
          input: 2,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
        },
      },
    });
    emit({ ...base, event: "turn.end", data: {} });
    emit({ ...base, event: "agent.end", data: {} });
    emit({ ...base, event: "session.idle", data: {} });
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("Turn cancelled."));
      },
      { once: true },
    );
  });
}
