import {
  PROTOCOL_VERSION,
  agent,
  methods,
  type AgentApp,
  type AgentContext,
  type ContentBlock,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";
import { randomUUID } from "node:crypto";
import type { BrokerPort, BrokerSessionEvent } from "./broker-port.ts";

export function createHostBackedAcpAgent(
  port: BrokerPort,
  clientId = `acp-${randomUUID()}`,
): AgentApp {
  const subscriptions = new Map<string, () => void>();
  const prompting = new Set<string>();
  const buffered = new Map<string, BrokerSessionEvent[]>();

  async function notify(client: AgentContext, sessionId: string, event: BrokerSessionEvent) {
    await client.notify(methods.client.session.update, {
      sessionId,
      update: mapBrokerEvent(event),
    });
  }

  async function attach(
    client: AgentContext,
    sessionId: string,
    replayFromStart: boolean,
  ) {
    subscriptions.get(sessionId)?.();
    const dispose = await port.subscribe(
      { clientId, sessionId, replayFromStart },
      async (event) => {
        if (prompting.has(sessionId)) {
          const pending = buffered.get(sessionId) ?? [];
          pending.push(event);
          buffered.set(sessionId, pending);
          return;
        }
        await notify(client, sessionId, event);
      },
    );
    subscriptions.set(sessionId, dispose);
  }

  function flushAfterPrompt(client: AgentContext, sessionId: string) {
    setTimeout(() => {
      prompting.delete(sessionId);
      const pending = buffered.get(sessionId) ?? [];
      buffered.delete(sessionId);
      void pending.reduce(
        (previous, event) => previous.then(() => notify(client, sessionId, event)),
        Promise.resolve(),
      );
    }, 0);
  }

  const app = agent({ name: "pi-tai-acp" })
    .onConnect((connection) => {
      void connection.closed.then(() => {
        for (const dispose of subscriptions.values()) dispose();
        subscriptions.clear();
      });
    })
    .onRequest(methods.agent.initialize, ({ params }) => ({
      protocolVersion: params.protocolVersion === PROTOCOL_VERSION
        ? params.protocolVersion
        : PROTOCOL_VERSION,
      info: { name: "pi-tai-acp", title: "Pi-Tai", version: "0.1.0" },
      capabilities: { session: {} },
    }))
    .onRequest(methods.agent.session.new, async ({ params, client }) => {
      const session = await port.create({ clientId, cwd: params.cwd });
      await attach(client, session.sessionId, false);
      return { sessionId: session.sessionId };
    })
    .onRequest(methods.agent.session.list, async ({ params }) => {
      const result = await port.list({
        ...(params.cwd ? { cwd: params.cwd } : {}),
        ...(params.cursor ? { cursor: params.cursor } : {}),
      });
      return {
        sessions: result.sessions.map((session) => ({
          sessionId: session.sessionId,
          cwd: session.cwd,
          ...(session.title === undefined ? {} : { title: session.title }),
          ...(session.updatedAt === undefined ? {} : { updatedAt: session.updatedAt }),
        })),
        ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
      };
    })
    .onRequest(methods.agent.session.resume, async ({ params, client }) => {
      await port.resume({ clientId, sessionId: params.sessionId, cwd: params.cwd });
      await attach(client, params.sessionId, params.replayFrom?.type === "start");
      return {};
    })
    .onRequest(methods.agent.session.close, async ({ params }) => {
      await port.close({ clientId, sessionId: params.sessionId });
      subscriptions.get(params.sessionId)?.();
      subscriptions.delete(params.sessionId);
      return {};
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      if (!subscriptions.has(params.sessionId)) await attach(client, params.sessionId, false);
      prompting.add(params.sessionId);
      try {
        await port.prompt({
          clientId,
          sessionId: params.sessionId,
          text: promptText(params.prompt),
        });
      } catch (error) {
        prompting.delete(params.sessionId);
        buffered.delete(params.sessionId);
        throw error;
      }
      flushAfterPrompt(client, params.sessionId);
      return {};
    })
    .onNotification(methods.agent.session.cancel, async ({ params }) => {
      await port.cancel({ clientId, sessionId: params.sessionId });
    });

  return app;
}

function promptText(blocks: ContentBlock[]): string {
  return blocks.map((block) => {
    if (block.type === "text" && typeof block.text === "string") return block.text;
    if (
      block.type === "resource_link"
      && typeof block.name === "string"
      && typeof block.uri === "string"
    ) {
      return `[Resource: ${block.name}] ${block.uri}`;
    }
    throw new Error(`Unsupported ACP prompt content: ${block.type}`);
  }).join("\n\n");
}

function mapBrokerEvent(event: BrokerSessionEvent): SessionUpdate {
  switch (event.type) {
    case "user_message":
      return {
        sessionUpdate: "user_message",
        messageId: event.messageId,
        content: [{ type: "text", text: event.content }],
      };
    case "assistant_text_delta":
      return {
        sessionUpdate: "agent_message_chunk",
        messageId: event.messageId,
        content: { type: "text", text: event.delta },
      };
    case "foreground_running":
      return { sessionUpdate: "state_update", state: "running" };
    case "foreground_idle":
      return {
        sessionUpdate: "state_update",
        state: "idle",
        ...(event.stopReason === undefined ? {} : { stopReason: event.stopReason }),
      };
  }
}
