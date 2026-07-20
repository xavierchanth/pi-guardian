import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiTaiConfigService } from "../../packages/pi-tai/src/config/register.ts";
import { DEFAULT_PI_TAI_CONFIG } from "../../packages/pi-tai/src/config/schema.ts";
import { registerAnsiTheme } from "../../packages/pi-tai/src/ansi-theme/register.ts";

type Handler = (event: unknown, ctx: any) => unknown;

function harness() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  const config = {
    ...DEFAULT_PI_TAI_CONFIG,
    ansiTheme: { ...DEFAULT_PI_TAI_CONFIG.ansiTheme, pollIntervalMs: 60_000 },
  };
  return {
    handlers,
    pi,
    config: { current: () => config } as PiTaiConfigService,
  };
}

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
  await emit(state.handlers, "session_shutdown", fakeContext("rpc"));
});

test("starts one TUI query, applies the theme, and aborts on shutdown", async () => {
  const state = harness();
  let queries = 0;
  let signal: AbortSignal | undefined;
  const themes: string[] = [];
  registerAnsiTheme(state.pi, state.config, async (receivedSignal) => {
    queries++;
    signal = receivedSignal;
    return "#111111";
  });
  const ctx = fakeContext("tui", themes);

  await emit(state.handlers, "session_start", ctx);
  assert.equal(queries, 1);
  assert.deepEqual(themes, ["ansi-dark"]);
  assert.equal(signal?.aborted, false);
  await emit(state.handlers, "session_shutdown", ctx);
  assert.equal(signal?.aborted, true);
});

function fakeContext(mode: string, themes: string[] = []) {
  return {
    mode,
    ui: {
      setTheme(theme: string) {
        themes.push(theme);
        return { success: true };
      },
    },
  };
}

async function emit(
  handlers: Map<string, Handler[]>,
  event: string,
  ctx: any,
): Promise<void> {
  for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
}
