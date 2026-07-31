import {
  CURRENT_RUNTIME_PROTOCOL_VERSION,
  RUNTIME_METHODS,
  RuntimeDecodeError,
  decodeMethodParams,
  decodeRuntimeCommand,
  errorResponse,
  isRuntimeMethod,
  successResponse,
  validateMethodResult,
  validateRuntimeEvent,
  type EmptyParams,
  type HostServiceResponseParams,
  type RuntimeCommand,
  type RuntimeInitializeParams,
  type RuntimeProtocolError,
  type SessionCancelParams,
  type SessionCreateParams,
  type SessionOpenParams,
  type SessionPromptParams,
  type SessionRelocateWorkspaceParams,
  type SessionSetModelParams,
  type SessionSetThinkingParams,
  type SessionTextParams,
} from "@pi-tai/runtime-protocol";
import type { DiagnosticSink } from "./diagnostics.ts";
import type { JsonlWriter } from "./jsonl.ts";
import { RuntimeHostServices } from "./host-services.ts";
import type { RuntimeEventInput, RuntimePort } from "./runtime-port.ts";

export type WorkerState =
  | "starting"
  | "ready_without_session"
  | "session_idle"
  | "turn_active"
  | "cancelling"
  | "stopping"
  | "stopped";

export class RuntimeWorker {
  private state: WorkerState = "starting";
  private commandIds = new Set<string>();
  private malformedSequence = 0;
  private workerSequence = 0;
  private runtimeGeneration = 0;
  private workerId = "";
  private sessionId?: string;
  private activeTurnId?: string;
  private activeCommandId?: string;
  private activeCompletion?: Promise<void>;
  private readonly port: RuntimePort;
  private readonly writer: JsonlWriter;
  private readonly diagnostics: DiagnosticSink;
  private readonly hostServices: RuntimeHostServices;

  constructor(port: RuntimePort, writer: JsonlWriter, diagnostics: DiagnosticSink) {
    this.port = port;
    this.writer = writer;
    this.diagnostics = diagnostics;
    this.hostServices = new RuntimeHostServices((event) => this.emit(event));
    this.port.bindHostServices?.(this.hostServices);
  }

  currentState(): WorkerState {
    return this.state;
  }

  async handleValue(value: unknown): Promise<void> {
    let command: RuntimeCommand;
    try {
      command = decodeRuntimeCommand(value);
    } catch (error) {
      const protocolError =
        error instanceof RuntimeDecodeError
          ? error.toProtocolError()
          : failure("invalid_envelope", "Runtime command envelope is invalid.");
      await this.writer.writeResponse(errorResponse(this.nextMalformedId(), protocolError));
      return;
    }

    if (this.commandIds.has(command.id)) {
      await this.writer.writeResponse(
        errorResponse(
          command.id,
          failure(
            "duplicate_command_id",
            "Command ID was already used for this worker generation.",
          ),
        ),
      );
      return;
    }
    this.commandIds.add(command.id);

    if (this.state === "starting" && command.method !== "runtime.initialize") {
      await this.writer.writeResponse(
        errorResponse(
          command.id,
          failure("initialization_required", "runtime.initialize must be the first command."),
        ),
      );
      return;
    }
    if (!isRuntimeMethod(command.method)) {
      await this.writer.writeResponse(
        errorResponse(
          command.id,
          failure("unsupported_command", `Unsupported runtime command: ${command.method}`),
        ),
      );
      return;
    }

    let params: unknown;
    try {
      params = decodeMethodParams(command.method, command.params);
    } catch (error) {
      const protocolError =
        error instanceof RuntimeDecodeError
          ? error.toProtocolError()
          : failure("invalid_params", `Parameters for ${command.method} are invalid.`);
      await this.writer.writeResponse(errorResponse(command.id, protocolError));
      return;
    }

    if (
      command.method !== "runtime.initialize" &&
      command.protocolVersion !== CURRENT_RUNTIME_PROTOCOL_VERSION
    ) {
      await this.writer.writeResponse(
        errorResponse(
          command.id,
          failure(
            "protocol_version_mismatch",
            `Expected runtime protocol ${CURRENT_RUNTIME_PROTOCOL_VERSION}.`,
          ),
        ),
      );
      return;
    }

    try {
      await this.dispatch(command, params);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Runtime command failed.";
      this.diagnostics({
        timestamp: new Date().toISOString(),
        level: "error",
        event: "command_failed",
        data: { method: command.method },
      });
      await this.writer.writeResponse(
        errorResponse(command.id, failure("runtime_error", redact(message))),
      );
    }
  }

  async handleMalformed(reason: string): Promise<void> {
    await this.writer.writeResponse(
      errorResponse(this.nextMalformedId(), failure("malformed_jsonl", reason)),
    );
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "stopping";
    if (this.activeTurnId) {
      this.emit({
        event: "session.interrupted",
        commandId: this.activeCommandId,
        sessionId: this.sessionId,
        turnId: this.activeTurnId,
        data: { reason: "worker_shutdown" },
      });
      await this.port.cancel(this.activeTurnId).catch(() => false);
    }
    await Promise.race([
      this.activeCompletion?.catch(() => undefined) ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await this.port.shutdown();
    this.hostServices.failAll("Runtime worker stopped before Host service response.");
    this.state = "stopped";
    await this.writer.flush();
  }

  private async dispatch(command: RuntimeCommand, params: unknown): Promise<void> {
    switch (command.method) {
      case "runtime.initialize":
        return this.initialize(command, params as RuntimeInitializeParams);
      case "session.create":
        return this.createSession(command, params as SessionCreateParams);
      case "session.open":
        return this.openSession(command, params as SessionOpenParams);
      case "session.prompt":
        return this.prompt(command, params as SessionPromptParams);
      case "session.steer":
        return this.steer(command, params as SessionTextParams);
      case "session.follow_up":
        return this.followUp(command, params as SessionTextParams);
      case "session.cancel":
        return this.cancel(command, params as SessionCancelParams);
      case "host.service_response":
        return this.hostServiceResponse(command, params as HostServiceResponseParams);
      case "session.set_model":
        return this.setModel(command, params as SessionSetModelParams);
      case "session.set_thinking":
        return this.setThinking(command, params as SessionSetThinkingParams);
      case "session.relocate_workspace":
        return this.relocateWorkspace(command, params as SessionRelocateWorkspaceParams);
      case "session.dispose":
        return this.disposeSession(command, params as EmptyParams);
      case "runtime.shutdown":
        return this.shutdown(command, params as EmptyParams);
    }
  }

  private async initialize(
    command: RuntimeCommand,
    params: RuntimeInitializeParams,
  ): Promise<void> {
    if (this.state !== "starting") throw new Error("Runtime is already initialized.");
    if (
      params.protocol.minVersion > CURRENT_RUNTIME_PROTOCOL_VERSION ||
      params.protocol.maxVersion < CURRENT_RUNTIME_PROTOCOL_VERSION
    ) {
      await this.writer.writeResponse(
        errorResponse(
          command.id,
          failure(
            "protocol_version_mismatch",
            `Runtime protocol ${CURRENT_RUNTIME_PROTOCOL_VERSION} is outside the requested range.`,
          ),
        ),
      );
      return;
    }
    this.workerId = params.workerId;
    this.runtimeGeneration = params.runtimeGeneration;
    const capabilities = await this.port.capabilities();
    capabilities.methods = [...RUNTIME_METHODS];
    this.state = "ready_without_session";
    const result = {
      protocolVersion: CURRENT_RUNTIME_PROTOCOL_VERSION,
      workerId: this.workerId,
      runtimeGeneration: this.runtimeGeneration,
      capabilities,
    };
    await this.writeSuccess(command, result);
    this.emit({ event: "runtime.ready", commandId: command.id, data: result });
  }

  private async createSession(command: RuntimeCommand, params: SessionCreateParams): Promise<void> {
    this.requireNoActiveTurn();
    const session = await this.port.createSession(params, (event) => this.emit(event));
    this.sessionId = session.sessionId;
    this.state = "session_idle";
    await this.writeSuccess(command, session);
  }

  private async openSession(command: RuntimeCommand, params: SessionOpenParams): Promise<void> {
    this.requireNoActiveTurn();
    const session = await this.port.openSession(params, (event) => this.emit(event));
    this.sessionId = session.sessionId;
    this.state = "session_idle";
    await this.writeSuccess(command, session);
  }

  private async prompt(command: RuntimeCommand, params: SessionPromptParams): Promise<void> {
    if (this.state !== "session_idle") throw new Error("Session is not idle.");
    const started = await this.port.startPrompt(params, command.id, (event) => this.emit(event));
    if (!started.accepted) {
      await this.writer.writeResponse(
        errorResponse(command.id, failure("prompt_rejected", "Prompt preflight rejected.")),
      );
      return;
    }
    this.state = "turn_active";
    this.activeTurnId = params.turnId;
    this.activeCommandId = command.id;
    this.activeCompletion = started.completion.then(
      () => {
        this.activeTurnId = undefined;
        this.activeCommandId = undefined;
        this.activeCompletion = undefined;
        if (this.state !== "stopping") this.state = "session_idle";
      },
      (error: unknown) => {
        const reason = error instanceof Error ? redact(error.message) : "Turn interrupted.";
        if (this.state !== "cancelling") {
          this.emit({
            event: "session.interrupted",
            commandId: command.id,
            sessionId: this.sessionId,
            turnId: params.turnId,
            data: { reason },
          });
        }
        this.emit({
          event: "session.idle",
          commandId: command.id,
          sessionId: this.sessionId,
          turnId: params.turnId,
          data: {},
        });
        this.activeTurnId = undefined;
        this.activeCommandId = undefined;
        this.activeCompletion = undefined;
        if (this.state !== "stopping") this.state = "session_idle";
      },
    );
    await this.writeSuccess(command, { accepted: true });
  }

  private async steer(command: RuntimeCommand, params: SessionTextParams): Promise<void> {
    if (this.state !== "turn_active") throw new Error("No active turn can be steered.");
    await this.writeSuccess(command, { accepted: await this.port.steer(params) });
  }

  private async followUp(command: RuntimeCommand, params: SessionTextParams): Promise<void> {
    if (this.state !== "turn_active") throw new Error("No active turn can accept a follow-up.");
    await this.writeSuccess(command, { accepted: await this.port.followUp(params) });
  }

  private async cancel(command: RuntimeCommand, params: SessionCancelParams): Promise<void> {
    const targeted = this.activeTurnId === params.turnId;
    if (targeted) this.state = "cancelling";
    const accepted = targeted ? await this.port.cancel(params.turnId) : false;
    if (accepted) {
      this.emit({
        event: "session.interrupted",
        commandId: this.activeCommandId,
        sessionId: this.sessionId,
        turnId: params.turnId,
        data: { reason: "cancelled" },
      });
    }
    await this.writeSuccess(command, { accepted });
  }

  private async hostServiceResponse(
    command: RuntimeCommand,
    params: HostServiceResponseParams,
  ): Promise<void> {
    this.hostServices.resolve({
      requestId: params.requestId,
      ok: params.ok,
      ...(params.result !== undefined && params.result !== null ? { result: params.result } : {}),
      ...(params.error ? { error: params.error } : {}),
    });
    await this.writeSuccess(command, {});
  }

  private async setModel(command: RuntimeCommand, params: SessionSetModelParams): Promise<void> {
    this.requireSessionIdle();
    await this.writeSuccess(command, await this.port.setModel(params));
  }

  private async setThinking(
    command: RuntimeCommand,
    params: SessionSetThinkingParams,
  ): Promise<void> {
    this.requireSessionIdle();
    await this.writeSuccess(command, await this.port.setThinking(params));
  }

  private async relocateWorkspace(
    command: RuntimeCommand,
    params: SessionRelocateWorkspaceParams,
  ): Promise<void> {
    this.requireSessionIdle();
    const session = await this.port.relocateWorkspace(params, (event) => this.emit(event));
    this.sessionId = session.sessionId;
    await this.writeSuccess(command, session);
  }

  private async disposeSession(command: RuntimeCommand, _params: EmptyParams): Promise<void> {
    this.requireNoActiveTurn();
    await this.port.disposeSession();
    this.sessionId = undefined;
    this.state = "ready_without_session";
    await this.writeSuccess(command, {});
  }

  private async shutdown(command: RuntimeCommand, _params: EmptyParams): Promise<void> {
    this.requireNoActiveTurn();
    this.state = "stopping";
    await this.port.shutdown();
    this.hostServices.failAll("Runtime worker shut down before Host service response.");
    await this.writeSuccess(command, {});
    this.state = "stopped";
  }

  private async writeSuccess(command: RuntimeCommand, result: unknown): Promise<void> {
    if (!isRuntimeMethod(command.method)) throw new Error(`Unsupported method: ${command.method}`);
    const validated = validateMethodResult(command.method, result);
    await this.writer.writeResponse(successResponse(command.id, validated));
  }

  private emit(input: RuntimeEventInput): void {
    const event = validateRuntimeEvent({
      protocolVersion: CURRENT_RUNTIME_PROTOCOL_VERSION,
      kind: "event",
      workerSequence: ++this.workerSequence,
      runtimeGeneration: this.runtimeGeneration,
      ...input,
    });
    void this.writer.writeEvent(event);
  }

  private requireNoActiveTurn(): void {
    if (this.state === "turn_active" || this.state === "cancelling") {
      throw new Error("Command is not allowed while a turn is active.");
    }
    if (this.state === "starting" || this.state === "stopping" || this.state === "stopped") {
      throw new Error(`Command is not allowed while worker is ${this.state}.`);
    }
  }

  private requireSessionIdle(): void {
    if (this.state !== "session_idle") throw new Error("A loaded idle session is required.");
  }

  private nextMalformedId(): string {
    return `protocol-${++this.malformedSequence}`;
  }
}

function failure(code: string, message: string): RuntimeProtocolError {
  return { code, message, retryable: false };
}

function redact(message: string): string {
  return message.replace(/[\r\n]+/g, " ").slice(0, 500) || "Runtime operation failed.";
}
