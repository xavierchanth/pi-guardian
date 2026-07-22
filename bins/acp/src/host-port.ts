import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HostConnection, readAuthToken } from "@pi-tai/host-client";
import {
  CURRENT_PROTOCOL_VERSION,
  type HostCommand,
  type HostEvent,
} from "@pi-tai/host-protocol";
import type {
  BrokerPort,
  BrokerSessionEvent,
  BrokerSessionSummary,
} from "./broker-port.ts";

const foregroundSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("idle"), last_stop_reason: z.string().nullable() }),
  z.object({ state: z.literal("running"), operation_id: z.string() }),
  z.object({
    state: z.literal("requires_action"),
    operation_id: z.string(),
    interaction_id: z.string(),
  }),
]);

const sessionSchema = z.object({
  sessionId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  runtimeGeneration: z.number().int().nonnegative(),
  foreground: foregroundSchema,
  piSession: z.object({
    sessionId: z.string(),
    sessionFile: z.string(),
    cwd: z.string(),
  }).nullable(),
});

type SessionSnapshot = z.infer<typeof sessionSchema>;

export interface HostBrokerPortOptions {
  socketPath: string;
  tokenFile: string;
  clientId?: string;
}

export class HostBrokerPort implements BrokerPort {
  private readonly socketPath: string;
  private readonly tokenFile: string;
  private readonly clientId: string;
  private readonly observers = new Map<string, HostConnection>();
  private readonly prompts = new Map<string, { operationId: string; text: string; cancelled: boolean }>();

  constructor(options: HostBrokerPortOptions) {
    this.socketPath = options.socketPath;
    this.tokenFile = options.tokenFile;
    this.clientId = options.clientId ?? `acp-${randomUUID()}`;
  }

  async create(input: { cwd: string }): Promise<BrokerSessionSummary> {
    const result = sessionSchema.parse(await this.command("session.create", undefined, undefined, {
      cwd: input.cwd,
    }));
    return summary(result);
  }

  async list(input: { cwd?: string }): Promise<{ sessions: BrokerSessionSummary[] }> {
    const values = z.array(sessionSchema).parse(await this.command("session.list", undefined, undefined, {}));
    return {
      sessions: values
        .map(summary)
        .filter((session) => input.cwd === undefined || session.cwd === input.cwd),
    };
  }

  async resume(input: { sessionId: string; cwd: string }): Promise<BrokerSessionSummary> {
    const result = await this.snapshot(input.sessionId);
    if (result.piSession?.cwd !== input.cwd) {
      throw new Error("ACP resume cwd does not match the broker session.");
    }
    return summary(result);
  }

  async close(input: { sessionId: string }): Promise<void> {
    const current = await this.snapshot(input.sessionId);
    if (current.foreground.state !== "idle") await this.cancel(input);
    this.observers.get(input.sessionId)?.close();
    this.observers.delete(input.sessionId);
  }

  async prompt(input: { sessionId: string; text: string }): Promise<void> {
    const current = await this.snapshot(input.sessionId);
    const operationId = randomUUID();
    this.prompts.set(input.sessionId, { operationId, text: input.text, cancelled: false });
    await this.command(
      "session.prompt",
      input.sessionId,
      current.revision,
      { text: input.text },
      operationId,
    );
  }

  async cancel(input: { sessionId: string }): Promise<void> {
    const current = await this.snapshot(input.sessionId);
    if (current.foreground.state === "idle") return;
    const pending = this.prompts.get(input.sessionId);
    if (pending) pending.cancelled = true;
    await this.command(
      "session.cancel",
      input.sessionId,
      current.revision,
      { operationId: current.foreground.operation_id },
    );
  }

  async subscribe(
    input: { sessionId: string; replayFromStart: boolean },
    onEvent: (event: BrokerSessionEvent) => void | Promise<void>,
  ): Promise<() => void> {
    if (input.replayFromStart) {
      throw new Error("Host replay-from-start is pending the durable broker integration.");
    }
    this.observers.get(input.sessionId)?.close();
    const connection = await this.connect();
    await connection.command(this.hostCommand("session.observe", input.sessionId, undefined, {}));
    this.observers.set(input.sessionId, connection);
    let disposed = false;
    void (async () => {
      try {
        while (!disposed) {
          const frame = await connection.read();
          if (frame.type !== "event" || frame.event.sessionId !== input.sessionId) continue;
          for (const event of this.mapEvent(frame.event)) await onEvent(event);
        }
      } catch {
        // Disconnect only detaches this ACP observer. The Host-owned turn continues.
      }
    })();
    return () => {
      disposed = true;
      connection.close();
      if (this.observers.get(input.sessionId) === connection) {
        this.observers.delete(input.sessionId);
      }
    };
  }

  private async snapshot(sessionId: string): Promise<SessionSnapshot> {
    return sessionSchema.parse(await this.command("session.snapshot", sessionId, undefined, {}));
  }

  private async command(
    kind: string,
    sessionId: string | undefined,
    expectedRevision: number | undefined,
    payload: unknown,
    operationId = randomUUID(),
  ): Promise<unknown> {
    const connection = await this.connect();
    try {
      return await connection.command(
        this.hostCommand(kind, sessionId, expectedRevision, payload, operationId),
      );
    } finally {
      connection.close();
    }
  }

  private hostCommand(
    kind: string,
    sessionId: string | undefined,
    expectedRevision: number | undefined,
    payload: unknown,
    operationId = randomUUID(),
  ): HostCommand {
    return {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: randomUUID(),
      operationId,
      clientId: this.clientId,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      kind,
      payload,
    };
  }

  private async connect(): Promise<HostConnection> {
    return HostConnection.connect({
      socketPath: this.socketPath,
      token: await readAuthToken(this.tokenFile),
      client: { name: "pi-tai-acp", version: "0.1.0" },
    });
  }

  private mapEvent(event: HostEvent): BrokerSessionEvent[] {
    const pending = this.prompts.get(event.sessionId);
    switch (event.type) {
      case "foreground.running":
        return [
          ...(pending
            ? [{ type: "user_message", messageId: `user-${pending.operationId}`, content: pending.text } as const]
            : []),
          { type: "foreground_running" },
        ];
      case "assistant.text_delta":
        return [{
          type: "assistant_text_delta",
          messageId: `assistant-${pending?.operationId ?? event.runtimeGeneration}`,
          delta: z.object({ delta: z.string() }).parse(event.payload).delta,
        }];
      case "session.idle": {
        this.prompts.delete(event.sessionId);
        return [{
          type: "foreground_idle",
          stopReason: pending?.cancelled ? "cancelled" : "end_turn",
        }];
      }
      default:
        return [];
    }
  }
}

function summary(session: SessionSnapshot): BrokerSessionSummary {
  return {
    sessionId: session.sessionId,
    cwd: session.piSession?.cwd ?? "",
  };
}
