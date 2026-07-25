import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ChildEventProtocol, type ChildMessageTarget } from "../../packages/pi-tai/src/concurrency/protocol.ts";
import { FileChildContextStore, type PersistedChildContextV4 } from "../../packages/pi-tai/src/concurrency/persistence.ts";

function context(parentContextId?: string): PersistedChildContextV4 {
  return {
    version: 4, contextId: "child-1", rootSessionId: "root-1", ...(parentContextId ? { parentContextId } : {}), cwd: "/repo",
    task: { objective: "work", uncertaintyHandling: "best-effort" },
    agent: {
      name: "worker", description: "worker", root: false, provider: "faux", model: "scripted", effort: "low",
      tools: [], allowedChildren: [], uncertaintyHandling: "best-effort", systemPrompt: "work", source: "packaged",
      filePath: "worker.md", contentHash: "hash",
    },
    execution: { phase: "running", cycleId: "cycle-1", startedAt: "now", sessionId: "session-1", sessionFile: "/private/session.jsonl" },
    events: [], usage: [], telemetryGaps: [], createdAt: "now", updatedAt: "now",
  };
}

test("protocol persists, delivers, and explicitly acknowledges terminal events", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-protocol-"));
  const store = new FileChildContextStore(join(root, "records"));
  await store.create(context());
  const messages: unknown[] = [];
  const rootBridge = { sendMessage: (...args: unknown[]) => { messages.push(args); } } as unknown as ExtensionAPI;
  const target: ChildMessageTarget = { message: async () => { throw new Error("unexpected nested delivery"); } };
  const ids = ["event-1"];
  const protocol = new ChildEventProtocol({ store, coordinator: target, rootBridge, id: () => ids.shift()!, now: () => "time" });
  const event = await protocol.emit("child-1", "cycle-1", { kind: "terminal", outcome: "completed", summary: "done" });
  assert.equal(event.delivery.phase, "delivered");
  assert.equal(messages.length, 1);
  assert.equal((messages[0] as any[])[0].display, false);
  assert.deepEqual((await protocol.unacknowledgedTerminalChildren("root-1")).map((item) => item.contextId), ["child-1"]);
  const acknowledged = await protocol.acknowledge("child-1", event.eventId);
  assert.equal(acknowledged.delivery.phase, "acknowledged");
  assert.deepEqual(await protocol.unacknowledgedTerminalChildren("root-1"), []);
  assert.equal((await protocol.acknowledge("child-1", event.eventId)).delivery.phase, "acknowledged");
});

test("protocol enforces one unresolved question and routes nested events to parent context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-protocol-question-"));
  const store = new FileChildContextStore(join(root, "records"));
  await store.create(context("parent-1"));
  const nested: unknown[] = [];
  const target: ChildMessageTarget = { message: async (...args) => { nested.push(args); } };
  const ids = ["question-1", "question-2"];
  const protocol = new ChildEventProtocol({
    store, coordinator: target, rootBridge: { sendMessage: () => {} } as unknown as ExtensionAPI,
    id: () => ids.shift()!, now: () => "time",
  });
  const question = await protocol.emit("child-1", "cycle-1", { kind: "question", question: "Choose?" });
  assert.equal(nested.length, 1);
  await assert.rejects(protocol.emit("child-1", "cycle-1", { kind: "question", question: "Again?" }), /unresolved question/);
  await protocol.answerQuestion("child-1", question.eventId, "Proceed");
  assert.equal((await store.get("child-1"))?.execution.phase, "running");
});

test("human execution requirements bypass intermediate agents and surface at the root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-protocol-human-"));
  const store = new FileChildContextStore(join(root, "records"));
  await store.create(context("parent-1"));
  const nested: unknown[] = [];
  const rootMessages: unknown[] = [];
  const protocol = new ChildEventProtocol({
    store,
    coordinator: { message: async (...args) => { nested.push(args); } },
    rootBridge: { sendMessage: (...args: unknown[]) => { rootMessages.push(args); } } as unknown as ExtensionAPI,
    id: () => "human-1",
    now: () => "time",
  });
  const event = await protocol.emit("child-1", "cycle-1", {
    kind: "human_execution_required",
    reason: "would delete production data",
    action: { toolName: "bash", arguments: { command: "prodctl delete database" }, cwd: "/repo" },
    reviewUnavailable: false,
  });
  assert.equal(event.delivery.phase, "delivered");
  assert.equal(nested.length, 0);
  assert.equal(rootMessages.length, 1);
  assert.equal((rootMessages[0] as any[])[0].customType, "pi-tai-human-execution-required-v1");
  assert.match((rootMessages[0] as any[])[0].content, /Do not execute it through another agent/);
  assert.match((rootMessages[0] as any[])[0].content, /prodctl delete database/);
});

test("protocol refuses a terminal report after cancellation is requested", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-protocol-cancelling-"));
  const store = new FileChildContextStore(join(root, "records"));
  await store.create({
    ...context(),
    execution: { phase: "cancelling", cycleId: "cycle-1", requestedAt: "now", reason: "parent request" },
  });
  const protocol = new ChildEventProtocol({
    store,
    coordinator: { message: async () => undefined },
    rootBridge: { sendMessage: () => {} } as unknown as ExtensionAPI,
  });
  await assert.rejects(
    protocol.emit("child-1", "cycle-1", { kind: "terminal", outcome: "completed", summary: "late completion" }),
    /after cancellation was requested/,
  );
  assert.equal((await store.get("child-1"))?.execution.phase, "cancelling");
});
