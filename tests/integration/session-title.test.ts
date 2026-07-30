import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SESSION_POLICY } from "../../packages/pi-tai/src/config/schema.ts";
import { registerSessionTitle } from "../../packages/pi-tai/src/session-title/register.ts";

type Handler = (event: any, ctx: any) => unknown;

function harness(options: { configured?: boolean; existingName?: string } = {}) {
  const handlers = new Map<string, Handler[]>();
  let name = options.existingName;
  const names: string[] = [];
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getSessionName: () => name,
    setSessionName(value: string) {
      name = value;
      names.push(value);
    },
  } as unknown as ExtensionAPI;
  const config = {
    ...DEFAULT_SESSION_POLICY,
    sessionTitle: {
      ...DEFAULT_SESSION_POLICY.sessionTitle,
      ...(options.configured ? { provider: "luna", model: "title-model" } : {}),
    },
  };
  const service = { sessionPolicy: () => config };
  return { handlers, names, pi, service };
}

async function emit(state: { handlers: Map<string, Handler[]> }, event: string, value: any = {}) {
  for (const handler of state.handlers.get(event) ?? []) await handler(value, fakeContext());
}

test("uses the configured independent model generator once", async () => {
  const state = harness({ configured: true });
  const calls: any[] = [];
  registerSessionTitle(state.pi, state.service, async (input) => {
    calls.push(input);
    return '"Repository plugin refresh!"';
  });

  await emit(state, "session_start");
  await emit(state, "before_agent_start", { prompt: "Implement the plugin system" });
  await emit(state, "agent_settled");
  await emit(state, "agent_settled");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].config.provider, "luna");
  assert.equal(calls[0].config.model, "title-model");
  assert.deepEqual(state.names, ["Repository plugin refresh"]);
});

test("uses heuristic fallback without calling a work model", async () => {
  const state = harness();
  let called = false;
  registerSessionTitle(state.pi, state.service, async () => {
    called = true;
    return "unused";
  });

  await emit(state, "session_start");
  await emit(state, "before_agent_start", { prompt: "Fix the title fallback now" });
  await emit(state, "agent_settled");

  assert.equal(called, false);
  assert.deepEqual(state.names, ["Fix the title fallback now"]);
});

test("does not overwrite an existing or manual name", async () => {
  const existing = harness({ configured: true, existingName: "Manual" });
  registerSessionTitle(existing.pi, existing.service, async () => "Generated");
  await emit(existing, "session_start");
  await emit(existing, "before_agent_start", { prompt: "Implement this" });
  await emit(existing, "agent_settled");
  assert.deepEqual(existing.names, []);
});

function fakeContext() {
  return {
    modelRegistry: {
      find: () => {
        throw new Error("active model registry must not be used by fake generation");
      },
    },
  };
}
