import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerContinueCommand } from "../../packages/pi-tai/src/continue/register.ts";

type CommandHandler = (args: string, ctx: any) => Promise<void> | void;

function harness(options: { idle?: boolean; hasHistory?: boolean } = {}) {
  let commandName = "";
  let commandDescription = "";
  let handler: CommandHandler | undefined;
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const events: string[] = [];
  let waits = 0;

  const pi = {
    registerCommand(name: string, command: { description?: string; handler: CommandHandler }) {
      commandName = name;
      commandDescription = command.description ?? "";
      handler = command.handler;
    },
    sendMessage(message: unknown, sendOptions: unknown) {
      events.push("send");
      sent.push({ message, options: sendOptions });
    },
  } as unknown as ExtensionAPI;

  registerContinueCommand(pi);

  const ctx = {
    isIdle: () => options.idle ?? true,
    sessionManager: {
      getBranch: () =>
        options.hasHistory === false
          ? []
          : [
              {
                type: "message",
                message: { role: "assistant" },
              },
            ],
    },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
    async waitForIdle() {
      events.push("wait");
      waits++;
    },
  };

  return {
    commandName,
    commandDescription,
    get handler() {
      assert.ok(handler);
      return handler;
    },
    ctx,
    sent,
    notifications,
    events,
    get waits() {
      return waits;
    },
  };
}

test("registers /continue and triggers a hidden continuation message", async () => {
  const state = harness();

  assert.equal(state.commandName, "continue");
  assert.match(state.commandDescription, /continue/i);

  await state.handler("", state.ctx);

  assert.deepEqual(state.sent, [
    {
      message: {
        customType: "pi-tai-continue",
        content: "Continue what you were doing.",
        display: false,
      },
      options: { triggerTurn: true },
    },
  ]);
  assert.deepEqual(state.events, ["send", "wait"]);
  assert.equal(state.waits, 1);
  assert.deepEqual(state.notifications, []);
});

test("does not queue continuation while the agent is busy", async () => {
  const state = harness({ idle: false });

  await state.handler("", state.ctx);

  assert.deepEqual(state.sent, []);
  assert.equal(state.waits, 0);
  assert.deepEqual(state.notifications, [
    { message: "The agent is still working.", level: "warning" },
  ]);
});

test("does not continue an empty conversation", async () => {
  const state = harness({ hasHistory: false });

  await state.handler("", state.ctx);

  assert.deepEqual(state.sent, []);
  assert.equal(state.waits, 0);
  assert.deepEqual(state.notifications, [
    { message: "There is no previous work to continue.", level: "info" },
  ]);
});

test("rejects command arguments", async () => {
  const state = harness();

  await state.handler("unexpected", state.ctx);

  assert.deepEqual(state.sent, []);
  assert.equal(state.waits, 0);
  assert.deepEqual(state.notifications, [
    { message: "Usage: /continue", level: "warning" },
  ]);
});
