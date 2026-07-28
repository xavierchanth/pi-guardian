import assert from "node:assert/strict";
import test from "node:test";
import { ChildEventWaitRegistry } from "../../packages/pi-tai/src/concurrency/waits.ts";
import type { PersistedChildEventV4 } from "../../packages/pi-tai/src/concurrency/persistence.ts";

function event(): PersistedChildEventV4 {
  return {
    eventId: "event-1", contextId: "child-1", cycleId: "cycle-1", kind: "terminal", payload: { summary: "done" },
    delivery: { phase: "delivered", createdAt: "now", deliveredAt: "now" },
  };
}

test("wait registry wakes on matching pushed event without polling", async () => {
  const waits = new ChildEventWaitRegistry();
  const pending = waits.wait({ callerId: "root", contextIds: ["child-1"], kinds: ["terminal"] });
  waits.notify(event());
  assert.deepEqual(await pending, { reason: "event", event: event() });
  assert.equal(waits.has("root"), false);
});

test("interactive input interrupts only the selected active wait", async () => {
  const waits = new ChildEventWaitRegistry();
  const root = waits.wait({ callerId: "root" });
  const child = waits.wait({ callerId: "child" });
  assert.equal(waits.interrupt("root"), true);
  assert.deepEqual(await root, { reason: "user_input" });
  assert.equal(waits.has("child"), true);
  waits.notify(event());
  assert.equal((await child).reason, "event");
});

test("wait registry handles cancellation and timeout", async () => {
  const waits = new ChildEventWaitRegistry();
  const controller = new AbortController();
  const cancelled = waits.wait({ callerId: "root", signal: controller.signal });
  controller.abort();
  assert.deepEqual(await cancelled, { reason: "cancelled" });
  assert.deepEqual(await waits.wait({ callerId: "root", timeoutMs: 1 }), { reason: "timeout" });
});
