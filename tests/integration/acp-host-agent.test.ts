import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTOCOL_VERSION,
  client,
  methods,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";
import type {
  BrokerPort,
  BrokerSessionEvent,
  BrokerSessionSummary,
} from "../../bins/acp/src/broker-port.ts";
import { createHostBackedAcpAgent } from "../../bins/acp/src/host-agent.ts";

class FakeBrokerPort implements BrokerPort {
  readonly session: BrokerSessionSummary = {
    sessionId: "broker-session-1",
    cwd: "/tmp/project",
    title: "Prototype session",
    updatedAt: "2026-07-22T00:00:00Z",
  };
  readonly calls: string[] = [];
  private listener?: (event: BrokerSessionEvent) => void | Promise<void>;

  async create() {
    this.calls.push("create");
    return this.session;
  }

  async list() {
    this.calls.push("list");
    return { sessions: [this.session] };
  }

  async resume() {
    this.calls.push("resume");
    return this.session;
  }

  async close() {
    this.calls.push("close");
  }

  async prompt(input: { text: string }) {
    this.calls.push(`prompt:${input.text}`);
    for (const event of [
      { type: "user_message", messageId: "user-1", content: input.text },
      { type: "foreground_running" },
      { type: "assistant_text_delta", messageId: "assistant-1", delta: "hello" },
      { type: "foreground_idle", stopReason: "end_turn" },
    ] satisfies BrokerSessionEvent[]) {
      await this.listener?.(event);
    }
  }

  async cancel() {
    this.calls.push("cancel");
  }

  async subscribe(
    input: { replayFromStart: boolean },
    listener: (event: BrokerSessionEvent) => void | Promise<void>,
  ) {
    this.calls.push(input.replayFromStart ? "subscribe:replay" : "subscribe:live");
    this.listener = listener;
    if (input.replayFromStart) {
      await listener({ type: "user_message", messageId: "replayed-user", content: "history" });
    }
    return () => {
      this.calls.push("dispose");
      if (this.listener === listener) this.listener = undefined;
    };
  }
}

test("official ACP v2 harness exercises the complete Host-backed baseline", async () => {
  const port = new FakeBrokerPort();
  const updates: SessionUpdate[] = [];
  const ordering: string[] = [];
  const harness = client({ name: "pi-tai-proof-client" }).onNotification(
    methods.client.session.update,
    ({ params }) => {
      updates.push(params.update);
      ordering.push(`update:${params.update.sessionUpdate}`);
    },
  );

  await harness.connectWith(createHostBackedAcpAgent(port, "acp-proof"), async (agent) => {
    const initialized = await agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      info: { name: "proof", version: "0.1.0" },
      capabilities: {},
    });
    assert.deepEqual(initialized.capabilities?.session, {});

    const created = await agent.request(methods.agent.session.new, {
      cwd: "/tmp/project",
    });
    assert.equal(created.sessionId, port.session.sessionId);

    const listed = await agent.request(methods.agent.session.list, {});
    assert.deepEqual(listed.sessions, [{
      sessionId: port.session.sessionId,
      cwd: port.session.cwd,
      title: port.session.title,
      updatedAt: port.session.updatedAt,
    }]);

    await agent.request(methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [
        { type: "text", text: "inspect" },
        { type: "resource_link", name: "spec", uri: "file:///tmp/spec.md" },
      ],
    });
    ordering.push("prompt-response");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(ordering[0], "prompt-response");
    assert.deepEqual(
      updates.map((update) => update.sessionUpdate),
      ["user_message", "state_update", "agent_message_chunk", "state_update"],
    );

    await agent.notify(methods.agent.session.cancel, { sessionId: created.sessionId });
    await agent.request(methods.agent.session.resume, {
      sessionId: created.sessionId,
      cwd: "/tmp/project",
      replayFrom: { type: "start" },
    });
    assert.ok(updates.some((update) =>
      update.sessionUpdate === "user_message" && update.messageId === "replayed-user"
    ));

    await agent.request(methods.agent.session.close, { sessionId: created.sessionId });
  });

  assert.ok(port.calls.includes("cancel"));
  assert.ok(port.calls.includes("subscribe:replay"));
  assert.ok(port.calls.includes("close"));
});
