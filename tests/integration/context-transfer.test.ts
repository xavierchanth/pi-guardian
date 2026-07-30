import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ContextTransferArtifact } from "../../packages/pi-tai/src/context-transfer/domain.ts";
import { registerContextTransfer } from "../../packages/pi-tai/src/context-transfer/register.ts";
import type { ContextTransferStore } from "../../packages/pi-tai/src/context-transfer/storage.ts";

function harness(options: { summarize?: () => Promise<string | undefined>; ids?: string[] } = {}) {
  const commands = new Map<string, { handler(args: string, ctx: any): Promise<void> }>();
  const messages: Array<{ message: any; options: any }> = [];
  const renderers: string[] = [];
  const notifications: Array<{ message: string; type: string }> = [];
  const statuses: unknown[] = [];
  const copies: string[] = [];
  const mutations: string[] = [];
  const records = new Map<string, ContextTransferArtifact>();
  const store: ContextTransferStore = {
    root: "/memory/pi-tai/context-exports",
    async exists(id) { return records.has(id); },
    async save(artifact) {
      if (records.has(artifact.id)) throw new Error("exists");
      records.set(artifact.id, artifact);
    },
    async load(id) {
      const artifact = records.get(id);
      if (!artifact) throw new Error(`No context export with ID ${id}.`);
      return artifact;
    },
    async prune() {},
  };
  const pi = {
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerMessageRenderer(type: string) { renderers.push(type); },
    sendMessage(message: any, sendOptions: any) { messages.push({ message, options: sendOptions }); },
    getThinkingLevel() { return "medium"; },
    appendEntry() { mutations.push("appendEntry"); },
    sendUserMessage() { mutations.push("sendUserMessage"); },
  };
  const ids = options.ids ?? ["ABCD2345"];
  registerContextTransfer(pi as never, "/memory", {
    store,
    summarize: async () => options.summarize ? options.summarize() : "Transferred summary",
    createId: () => ids.shift() ?? "ABCD2345",
    copy: async (text) => { copies.push(text); },
    now: () => new Date("2025-01-01T00:00:00.000Z"),
  });
  const ctx = {
    cwd: "/work",
    model: { provider: "test", id: "model" },
    sessionManager: {
      getSessionId: () => "session-1",
      getEntries: () => [],
      getLeafId: () => undefined,
    },
    ui: {
      notify(message: string, type: string) { notifications.push({ message, type }); },
      setStatus(_key: string, value: unknown) { statuses.push(value); },
    },
    async waitForIdle() {},
  };
  return { commands, messages, renderers, notifications, statuses, copies, mutations, records, ctx };
}

describe("context transfer commands", () => {
  it("exports one artifact without mutating the source session", async () => {
    const state = harness();
    await state.commands.get("context-export")!.handler("focus on auth", state.ctx);

    assert.equal(state.records.size, 1);
    const artifact = state.records.get("ABCD2345")!;
    assert.equal(artifact.summary, "Transferred summary");
    assert.equal(artifact.notes, "focus on auth");
    assert.deepEqual(state.mutations, []);
    assert.deepEqual(state.messages, []);
    assert.deepEqual(state.copies, ["/context-import ABCD2345"]);
    assert.deepEqual(state.statuses, ["Exporting context…", undefined]);
    assert.deepEqual(state.renderers, ["pi-tai:context-import"]);
  });

  it("retries collisions and imports one durable triggered message", async () => {
    const state = harness({ ids: ["ABCD2345", "BCDE3456"] });
    state.records.set("ABCD2345", {
      version: 1,
      id: "ABCD2345",
      createdAt: "2025-01-01T00:00:00.000Z",
      summary: "old",
      source: { cwd: "/old", sessionId: "old", model: { provider: "p", id: "m" }, piTaiVersion: "0.1.0" },
    });
    await state.commands.get("context-export")!.handler("", state.ctx);
    await state.commands.get("context-import")!.handler("BCDE3456", state.ctx);

    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0]!.message.customType, "pi-tai:context-import");
    assert.equal(state.messages[0]!.message.display, true);
    assert.match(state.messages[0]!.message.content, /Transferred summary/);
    assert.deepEqual(state.messages[0]!.options, { triggerTurn: true });
  });

  it("sends nothing when export or import fails", async () => {
    const empty = harness({ summarize: async () => undefined });
    await empty.commands.get("context-export")!.handler("", empty.ctx);
    await empty.commands.get("context-import")!.handler("ABCD2345", empty.ctx);

    assert.equal(empty.records.size, 0);
    assert.equal(empty.messages.length, 0);
    assert.match(empty.notifications.at(-1)!.message, /No context export/);
  });
});
