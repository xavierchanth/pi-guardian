import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";
import type { LifecycleRecord } from "../../packages/pi-tai/src/core/subagents/lifecycle.ts";
import type { DurableRecordStore } from "../../packages/pi-tai/src/core/durable/port.ts";
import {
  InMemoryRecordStore,
  SubagentRecordIndex,
} from "../../packages/pi-tai/src/core/subagents/records.ts";

function record(durableId: string, overrides: Partial<LifecycleRecord> = {}): LifecycleRecord {
  return {
    durableId,
    displayId: `sa-${durableId}`,
    sequence: 1,
    generation: 1,
    backend: "pi",
    title: "task",
    cwd: "/tmp",
    disposition: "done",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

it("indexes records idempotently and keeps the incumbent on equal timestamps", () => {
  const index = new SubagentRecordIndex("own");
  index.ingest([record("1", { rootSessionId: "own" })]);
  index.ingest([record("1", { rootSessionId: "other" })]);
  assert.deepEqual(index.counts(), { unarchived: 1, archived: 0, inherited: 0, total: 1 });
  index.note(record("1", { rootSessionId: "other", updatedAt: "2026-01-02T00:00:00Z" }));
  assert.deepEqual(index.counts(), { unarchived: 0, archived: 0, inherited: 1, total: 1 });
});

it("authoritative terminal facts replace intent on a timestamp tie", () => {
  const store: DurableRecordStore = new InMemoryRecordStore();
  store.note(record("1", { disposition: "intent" }));
  store.note(record("1", { disposition: "failed" }), true);
  assert.equal(store.get("1")?.disposition, "failed");
});

it("counts archived, inherited, and legacy records honestly", () => {
  const index = new SubagentRecordIndex("own");
  index.ingest([
    record("legacy"),
    record("archived", { rootSessionId: "own", archivedAt: "now" }),
    record("fork", { rootSessionId: "ancestor" }),
  ]);
  assert.deepEqual(index.counts(), { unarchived: 1, archived: 1, inherited: 1, total: 3 });
});

it("live note followed by fold ingestion does not double count", () => {
  const index = new SubagentRecordIndex();
  index.note(record("1"));
  index.ingest([record("1", { updatedAt: "2026-01-02T00:00:00Z" })]);
  assert.equal(index.counts().total, 1);
});

it("residency prune never calls durable forget", async () => {
  const manager = await readFile(
    new URL("../../packages/pi-tai/src/core/subagents/manager.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(manager, /\.forget\s*\(/);
});
