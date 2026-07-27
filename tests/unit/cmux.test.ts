import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCmux } from "../../packages/pi-tai/src/cmux/register.ts";
import { DEFAULT_CLIENT_PREFERENCES } from "../../packages/pi-tai/src/config/schema.ts";

function harness(enabled = true) {
  const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
  const calls: string[] = [];
  const pi = {
    on(name: string, handler: (event: unknown, context: unknown) => unknown) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  let currentEnabled = enabled;
  const config = {
    clientPreferences: () => ({
      ...DEFAULT_CLIENT_PREFERENCES,
      cmux: { enabled: currentEnabled },
    }),
  };
  return {
    pi,
    config,
    handlers,
    calls,
    setEnabled(value: boolean) {
      currentEnabled = value;
    },
  };
}

test("cmux modules are not initialized outside a cmux workspace", async () => {
  const state = harness();
  const registered = await registerCmux(state.pi, state.config, {
    environment: {},
    initI18n: () => state.calls.push("i18n"),
    registerNotify: () => state.calls.push("notify"),
    registerSidebar: () => state.calls.push("sidebar"),
  });
  assert.equal(registered, false);
  assert.deepEqual(state.calls, []);
});

test("cmux composes only i18n, notifications, and sidebar with a dynamic preference gate", async () => {
  const state = harness(false);
  const registerFeature = (name: string) => (pi: ExtensionAPI) => {
    state.calls.push(name);
    const on = pi.on as unknown as (event: string, handler: () => void) => void;
    on(`cmux:${name}`, () => state.calls.push(`${name}:event`));
  };
  const registered = await registerCmux(state.pi, state.config, {
    environment: { CMUX_WORKSPACE_ID: "workspace-1" },
    initI18n: () => state.calls.push("i18n"),
    registerNotify: registerFeature("notify"),
    registerSidebar: registerFeature("sidebar"),
  });
  assert.equal(registered, true);
  assert.deepEqual(state.calls, ["i18n", "notify", "sidebar"]);

  state.handlers.get("cmux:notify")?.({}, {});
  state.handlers.get("cmux:sidebar")?.({}, {});
  assert.deepEqual(state.calls, ["i18n", "notify", "sidebar"]);

  state.setEnabled(true);
  state.handlers.get("cmux:notify")?.({}, {});
  state.handlers.get("cmux:sidebar")?.({}, {});
  assert.deepEqual(state.calls, ["i18n", "notify", "sidebar", "notify:event", "sidebar:event"]);
});
