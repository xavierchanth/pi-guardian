import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SESSION_POLICY } from "../../packages/pi-tai/src/core/config/schema.ts";
import { registerAutoCompaction } from "../../packages/pi-tai/src/core/compaction/register.ts";

type Handler = (event: unknown, ctx: any) => Promise<void> | void;

function harness(
  options: {
    enabled?: boolean;
    thresholdPercent?: number;
    percent?: number | null;
    idle?: boolean;
  } = {},
) {
  const handlers = new Map<string, Handler>();
  const notifications: Array<{ message: string; level: string }> = [];
  const compactCalls: Array<Record<string, unknown>> = [];
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  const config = {
    sessionPolicy: () => ({
      ...DEFAULT_SESSION_POLICY,
      compaction: {
        enabled: options.enabled ?? true,
        thresholdPercent: options.thresholdPercent ?? 90,
      },
    }),
  };
  const ctx = {
    isIdle: () => options.idle ?? true,
    getContextUsage: () => ({
      tokens: options.percent === null ? null : 90_000,
      contextWindow: 100_000,
      percent: options.percent === undefined ? 90 : options.percent,
    }),
    compact(callbacks: Record<string, unknown>) {
      compactCalls.push(callbacks);
    },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };
  registerAutoCompaction(pi, config);
  return { handlers, ctx, compactCalls, notifications };
}

test("compacts when settled context reaches the configured percentage", async () => {
  const state = harness({ percent: 90 });
  const settled = state.handlers.get("agent_settled");
  const completion = settled?.({}, state.ctx);

  assert.equal(state.compactCalls.length, 1);
  let resolved = false;
  void Promise.resolve(completion).then(() => {
    resolved = true;
  });
  await Promise.resolve();
  assert.equal(resolved, false);

  (state.compactCalls[0]?.onComplete as (() => void) | undefined)?.();
  await completion;
  assert.equal(resolved, true);
});

test("does not compact below threshold, with unknown usage, while busy, or when disabled", async () => {
  for (const state of [
    harness({ percent: 89.9 }),
    harness({ percent: null }),
    harness({ percent: 95, idle: false }),
    harness({ percent: 95, enabled: false }),
  ]) {
    await state.handlers.get("agent_settled")?.({}, state.ctx);
    assert.equal(state.compactCalls.length, 0);
  }
});

test("suppresses duplicate triggers while compaction is in progress", async () => {
  const state = harness({ percent: 95 });
  const settled = state.handlers.get("agent_settled");
  const first = settled?.({}, state.ctx);
  await settled?.({}, state.ctx);

  assert.equal(state.compactCalls.length, 1);
  (state.compactCalls[0]?.onComplete as (() => void) | undefined)?.();
  await first;
});

test("reports failures and allows a later compaction attempt", async () => {
  const state = harness({ percent: 95 });
  const settled = state.handlers.get("agent_settled");
  const first = settled?.({}, state.ctx);
  (state.compactCalls[0]?.onError as ((error: Error) => void) | undefined)?.(new Error("quota"));
  await first;

  assert.deepEqual(state.notifications, [
    {
      message: "Automatic compaction failed: quota",
      level: "warning",
    },
  ]);

  const second = settled?.({}, state.ctx);
  assert.equal(state.compactCalls.length, 2);
  (state.compactCalls[1]?.onComplete as (() => void) | undefined)?.();
  await second;
});
