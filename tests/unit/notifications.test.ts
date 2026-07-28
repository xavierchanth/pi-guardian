import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CLIENT_PREFERENCES, type NotificationsConfig } from "../../packages/pi-tai/src/config/schema.ts";
import { GUARDIAN_REVIEW_FAILED_EVENT } from "../../packages/pi-tai/src/notifications/events.ts";
import { terminalNotificationSequence } from "../../packages/pi-tai/src/notifications/native.ts";
import { registerNotifications } from "../../packages/pi-tai/src/notifications/register.ts";

interface HarnessOptions {
  sessionName?: string;
  environment?: NodeJS.ProcessEnv;
  cmuxEnabled?: boolean;
}

function harness(
  notifications: NotificationsConfig = DEFAULT_CLIENT_PREFERENCES.notifications,
  options: HarnessOptions = {},
) {
  const handlers = new Map<string, (event: unknown, ctx: any) => void>();
  const eventHandlers = new Map<string, (data: unknown) => void>();
  const sent: Array<{ title: string; body: string }> = [];
  const pi = {
    getSessionName: () => options.sessionName,
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
    clientPreferences: () => ({
      ...DEFAULT_CLIENT_PREFERENCES,
      notifications,
      cmux: { enabled: options.cmuxEnabled ?? true },
    }),
  };
  registerNotifications(
    pi,
    config,
    (title, body) => sent.push({ title, body }),
    options.environment ?? {},
    (_config, environment) => Boolean(environment?.CMUX_WORKSPACE_ID?.trim())
      && (options.cmuxEnabled ?? true),
  );
  return { handlers, eventHandlers, sent };
}

function settledContext(content?: unknown, cwd = "/work/example") {
  return {
    mode: "tui",
    cwd,
    sessionManager: {
      buildContextEntries: () => content === undefined ? [] : [
        { type: "message", message: { role: "assistant", content } },
      ],
    },
  };
}

test("notifies in TUI when agent work settles", () => {
  const state = harness();
  state.handlers.get("agent_settled")?.({}, settledContext());
  assert.deepEqual(state.sent, [{ title: "Pi-Tai · example", body: "Ready for input." }]);
});

test("completion notifications identify the session and summarize the assistant response", () => {
  const state = harness(DEFAULT_CLIENT_PREFERENCES.notifications, { sessionName: "Refactor runtime" });
  state.handlers.get("agent_settled")?.({}, settledContext([
    { type: "thinking", text: "hidden" },
    { type: "text", text: "Implemented the change.\nAll checks pass." },
  ]));
  assert.deepEqual(state.sent, [{
    title: "Pi-Tai · Refactor runtime",
    body: "Implemented the change. All checks pass.",
  }]);
});

test("notifies when automatic review fails or times out with available detail", () => {
  const state = harness(DEFAULT_CLIENT_PREFERENCES.notifications, { sessionName: "Deploy audit" });
  const emit = state.eventHandlers.get(GUARDIAN_REVIEW_FAILED_EVENT);
  emit?.({ kind: "failure", mode: "tui", toolName: "bash", reason: "Reviewer unavailable." });
  emit?.({ kind: "timeout", mode: "tui" });
  assert.deepEqual(state.sent, [
    { title: "Pi-Tai · Deploy audit", body: "bash — Reviewer unavailable." },
    { title: "Pi-Tai · Deploy audit", body: "Automatic action review timed out." },
  ]);
});

test("cmux owns completion notifications while its integration is active", () => {
  const active = harness(DEFAULT_CLIENT_PREFERENCES.notifications, {
    environment: { CMUX_WORKSPACE_ID: "workspace-1" },
  });
  active.handlers.get("agent_settled")?.({}, settledContext([{ type: "text", text: "Done" }]));
  assert.deepEqual(active.sent, []);

  const disabled = harness(DEFAULT_CLIENT_PREFERENCES.notifications, {
    environment: { CMUX_WORKSPACE_ID: "workspace-1" },
    cmuxEnabled: false,
  });
  disabled.handlers.get("agent_settled")?.({}, settledContext([{ type: "text", text: "Done" }]));
  assert.deepEqual(disabled.sent, [{ title: "Pi-Tai · example", body: "Done" }]);
});

test("notification settings and headless modes suppress configured output", () => {
  const disabled = harness({ reviewFailure: false, agentCompletion: false });
  disabled.handlers.get("agent_settled")?.({}, settledContext());
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
