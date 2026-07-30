import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CLIENT_PREFERENCES } from "../../packages/pi-tai/src/config/schema.ts";
import { queryTerminalBackground } from "../../packages/pi-tai/src/ansi-theme/query.ts";
import { registerAnsiTheme } from "../../packages/pi-tai/src/ansi-theme/register.ts";

type Handler = (event: unknown, ctx: any) => unknown;

function harness(pollIntervalMs = 60_000) {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  const config = {
    ...DEFAULT_CLIENT_PREFERENCES,
    ansiTheme: { ...DEFAULT_CLIENT_PREFERENCES.ansiTheme, pollIntervalMs },
  };
  return { handlers, pi, config: { clientPreferences: () => config } };
}

test("uses the active TUI query and removes its abort listener", async () => {
  const controller = new AbortController();
  let options: unknown;
  let resolveColor!: (color: { r: number; g: number; b: number }) => void;
  const color = new Promise<{ r: number; g: number; b: number }>((resolve) => {
    resolveColor = resolve;
  });
  const pending = queryTerminalBackground(
    {
      queryTerminalBackgroundColor(received) {
        options = received;
        return color;
      },
    },
    controller.signal,
  );

  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  resolveColor({ r: -4, g: 15.6, b: 999 });

  assert.equal(await pending, "#0010ff");
  assert.deepEqual(options, { timeoutMs: 500 });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("removes its abort listener when aborted", async () => {
  const controller = new AbortController();
  const pending = queryTerminalBackground(
    {
      queryTerminalBackgroundColor: () => new Promise(() => {}),
    },
    controller.signal,
  );

  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort();

  assert.equal(await pending, undefined);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("does no terminal work outside TUI mode", async () => {
  const state = harness();
  let queries = 0;
  registerAnsiTheme(state.pi, state.config, async () => {
    queries++;
    return "#000000";
  });

  for (const mode of ["print", "json", "rpc"]) {
    await emit(state.handlers, "session_start", fakeContext(mode));
  }
  assert.equal(queries, 0);
});

test("polls after valid responses and cleans up on shutdown", async () => {
  const state = harness(5);
  let queries = 0;
  const ctx = fakeContext("tui");
  registerAnsiTheme(state.pi, state.config, async (tui) => {
    assert.equal(tui, ctx.tui);
    queries++;
    return "#111111";
  });

  await emit(state.handlers, "session_start", ctx);
  await delay(18);
  assert.ok(queries >= 2);
  await emit(state.handlers, "session_shutdown", ctx);
  const stoppedAt = queries;
  await delay(12);
  assert.equal(queries, stoppedAt);
  assert.equal(ctx.widgets.size, 0);
});

test("stops polling after an unsupported response", async () => {
  const state = harness(5);
  let queries = 0;
  const ctx = fakeContext("tui");
  registerAnsiTheme(state.pi, state.config, async () => {
    queries++;
    return undefined;
  });

  await emit(state.handlers, "session_start", ctx);
  await delay(15);
  assert.equal(queries, 1);
  await emit(state.handlers, "session_shutdown", ctx);
});

test("shutdown suppresses stale results", async () => {
  const state = harness();
  let resolveQuery!: (value: string) => void;
  const pending = new Promise<string>((resolve) => {
    resolveQuery = resolve;
  });
  const themes: string[] = [];
  registerAnsiTheme(state.pi, state.config, async () => pending);
  const ctx = fakeContext("tui", themes);

  const starting = emit(state.handlers, "session_start", ctx);
  await emit(state.handlers, "session_shutdown", ctx);
  resolveQuery("#ffffff");
  await starting;

  assert.deepEqual(themes, []);
  assert.equal(ctx.widgets.size, 0);
});

test("failed theme applications can retry", async () => {
  const state = harness(5);
  const ctx = fakeContext("tui");
  let applications = 0;
  ctx.ui.setTheme = () => ({ success: ++applications > 1 });
  registerAnsiTheme(state.pi, state.config, async () => "#111111");

  await emit(state.handlers, "session_start", ctx);
  await delay(12);
  await emit(state.handlers, "session_shutdown", ctx);

  assert.ok(applications >= 2);
});

function fakeContext(mode: string, themes: string[] = []) {
  const tui = { queryTerminalBackgroundColor: async () => undefined };
  const widgets = new Map<string, unknown>();
  return {
    mode,
    tui,
    widgets,
    ui: {
      setTheme(theme: string) {
        themes.push(theme);
        return { success: true };
      },
      setWidget(key: string, content: any) {
        if (content === undefined) widgets.delete(key);
        else {
          widgets.set(key, content);
          content(tui, {});
        }
      },
    },
  };
}

async function emit(handlers: Map<string, Handler[]>, event: string, ctx: any): Promise<void> {
  for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
