import assert from "node:assert/strict";
import { it } from "node:test";
import { BackendRegistry } from "../../packages/pi-tai/src/core/subagents/backend.ts";
import { StubBackend } from "../../packages/pi-tai/src/core/subagents/backends/stub.ts";
import type {
  LifecycleEvent,
  SubagentLifecycleStore,
} from "../../packages/pi-tai/src/core/subagents/lifecycle.ts";
import {
  MAX_DURABLE_RECORDS,
  MAX_RESIDENT_SUBAGENTS,
  MAX_RUNNING_SUBAGENTS,
  MAX_UNARCHIVED_RECORDS,
  MAX_TRACKED_SUBAGENTS,
  SubagentCapacityError,
  SubagentManager,
} from "../../packages/pi-tai/src/core/subagents/manager.ts";

const request = (n: number) => ({
  backend: "pi" as const,
  prompt: `HANG: ${n}`,
  systemPrompt: "worker",
  cwd: "/tmp",
  title: `task ${n}`,
});
const manager = (
  options: Omit<ConstructorParameters<typeof SubagentManager>[0], "registry"> = {},
) => new SubagentManager({ registry: new BackendRegistry([new StubBackend()]), ...options });

it("ships the 32/4096/256 bounds and compatibility alias", () => {
  assert.equal(MAX_RUNNING_SUBAGENTS, 32);
  assert.equal(MAX_DURABLE_RECORDS, 4096);
  assert.equal(MAX_UNARCHIVED_RECORDS, 128);
  assert.equal(MAX_RESIDENT_SUBAGENTS, 256);
  assert.equal(MAX_TRACKED_SUBAGENTS, MAX_RESIDENT_SUBAGENTS);
});

it("uses an injected durable record store for admission and reporting", () => {
  let countCalls = 0;
  const records = {
    ingest: () => {},
    note: () => {},
    get: () => undefined,
    isInherited: () => false,
    counts: () => {
      countCalls += 1;
      return { unarchived: 2, archived: 3, inherited: 4, total: 9 };
    },
  };
  const agents = manager({ records });
  assert.equal(agents.capacity().durable, 9);
  agents.assertAdmission();
  assert.ok(countCalls >= 2);
});

it("reserves synchronously and returns typed running diagnostics", async () => {
  const agents = manager({ maxRunning: 2 });
  const first = agents.spawn(request(1));
  const second = agents.spawn(request(2));
  assert.throws(
    () => agents.assertAdmission(),
    (error) =>
      error instanceof SubagentCapacityError &&
      error.kind === "running" &&
      error.message.includes("/subagents"),
  );
  await Promise.all([first, second]);
  assert.equal(agents.capacity().running, 2);
  await agents.shutdown();
});

it("enforces durable capacity without lifecycle persistence", async () => {
  const agents = manager({
    maxRunning: 3,
    maxDurable: 1,
  });
  const spawned = await agents.spawn(request(1));
  await agents.cancel([spawned.id]);
  assert.throws(
    () => agents.assertAdmission(),
    (error) =>
      error instanceof SubagentCapacityError &&
      error.kind === "durable" &&
      !error.message.includes("archive"),
  );
  assert.equal(agents.capacity().archiveEnforced, false);
});

it("residency pruning protects an undrained deferred result", async () => {
  const agents = manager({ maxResident: 1 });
  const first = await agents.spawn({ ...request(1), prompt: "complete" });
  await agents.wait([first.id]); // consume first so it becomes evictable
  const second = await agents.spawn({ ...request(2), prompt: "complete" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(agents.get(second.id)?.deliveryPending, true);
  await agents.spawn(request(3));
  assert.ok(agents.get(second.id), "undrained result remains resident above the soft bound");
  assert.ok(agents.capacity().resident > agents.capacity().maxResident);
  await agents.shutdown();
});

it("resolved workspace custody becomes evictable while unresolved custody stays protected", async () => {
  const agents = manager({ maxResident: 1 });
  const first = await agents.spawn({ ...request(1), prompt: "complete", workspaceId: "ws-1" });
  await agents.wait([first.id]);
  const second = await agents.spawn({ ...request(2), prompt: "complete", workspaceId: "ws-2" });
  await agents.wait([second.id]);
  await agents.spawn(request(3));
  assert.ok(agents.get(first.id), "unresolved historical workspace custody remains resident");
  agents.resolveCustody(first.id);
  assert.equal(agents.get(first.id), undefined);
  assert.ok(agents.get(second.id), "other unresolved custody remains protected");
  await agents.shutdown();
});

it("reload and repeated tree ingestion preserve durable counts but not running reservations", async () => {
  const events: LifecycleEvent[] = [
    {
      version: 1,
      type: "spawn_intent",
      durableId: "d1",
      displayId: "sa-1",
      sequence: 1,
      generation: 1,
      backend: "pi",
      title: "old",
      cwd: "/tmp",
      rootSessionId: "own",
      at: "2026-01-01T00:00:00Z",
    },
  ];
  const store: SubagentLifecycleStore = {
    load: async () => events,
    append: async (event) => void events.push(event),
  };
  const agents = manager({ rootSessionId: "own" });
  await agents.attachLifecycleStore(store);
  const first = agents.capacity();
  await agents.attachLifecycleStore(store);
  assert.equal(first.running, 0);
  assert.equal(first.unarchived, 1);
  assert.deepEqual(agents.capacity(), first);
});
