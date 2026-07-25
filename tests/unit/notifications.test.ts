import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CLIENT_PREFERENCES, type NotificationsConfig } from "../../packages/pi-tai/src/config/schema.ts";
import { GUARDIAN_REVIEW_FAILED_EVENT } from "../../packages/pi-tai/src/notifications/events.ts";
import { terminalNotificationSequence } from "../../packages/pi-tai/src/notifications/native.ts";
import { registerNotifications } from "../../packages/pi-tai/src/notifications/register.ts";

function harness(notifications: NotificationsConfig = DEFAULT_CLIENT_PREFERENCES.notifications) {
  const handlers = new Map<string, (event: unknown, ctx: any) => void>();
  const eventHandlers = new Map<string, (data: unknown) => void>();
  const sent: Array<{ title: string; body: string }> = [];
  const pi = {
    on(name: string, handler: (event: unknown, ctx: any) => void) {
      handlers.set(name, handler);
    },
    events: {
      on(name: string, handler: (data: unknown) => void) {
        eventHandlers.set(name, handler);
      },
    },
  } as unknown as ExtensionAPI;
  const config = {
    clientPreferences: () => ({ ...DEFAULT_CLIENT_PREFERENCES, notifications }),
  };
  registerNotifications(pi, config, (title, body) => sent.push({ title, body }));
  return { handlers, eventHandlers, sent };
}

test("notifies in TUI when agent work settles", () => {
  const state = harness();
  state.handlers.get("agent_settled")?.({}, { mode: "tui" });
  assert.deepEqual(state.sent, [{ title: "Pi-Tai", body: "Ready for input." }]);
});

test("notifies when automatic review fails or times out", () => {
  const state = harness();
  const emit = state.eventHandlers.get(GUARDIAN_REVIEW_FAILED_EVENT);
  emit?.({ kind: "failure", mode: "tui" });
  emit?.({ kind: "timeout", mode: "tui" });
  assert.deepEqual(state.sent, [
    { title: "Pi-Tai review", body: "Automatic action review failed." },
    { title: "Pi-Tai review", body: "Automatic action review timed out." },
  ]);
});

test("notification settings and headless modes suppress configured output", () => {
  const disabled = harness({ reviewFailure: false, agentCompletion: false });
  disabled.handlers.get("agent_settled")?.({}, { mode: "tui" });
  disabled.eventHandlers.get(GUARDIAN_REVIEW_FAILED_EVENT)?.({ kind: "failure", mode: "tui" });
  assert.deepEqual(disabled.sent, []);

  const headless = harness();
  headless.handlers.get("agent_settled")?.({}, { mode: "print" });
  headless.eventHandlers.get(GUARDIAN_REVIEW_FAILED_EVENT)?.({ kind: "failure", mode: "rpc" });
  assert.deepEqual(headless.sent, []);
});

test("terminal notification sequences support Kitty and OSC 777 safely with an audible bell", () => {
  assert.equal(
    terminalNotificationSequence({ KITTY_WINDOW_ID: "1" }, "Pi", "Ready"),
    "\x1b]99;i=pi-tai:d=0;Pi\x1b\\\x1b]99;i=pi-tai:p=body;Ready\x1b\\\x07",
  );
  const generic = terminalNotificationSequence({}, "Pi;bad", "Done\x07now");
  assert.equal(generic, "\x1b]777;notify;Pi bad;Done now\x07\x07");
});
