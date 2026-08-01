import assert from "node:assert/strict";
import test from "node:test";
import {
  foldLifecycle,
  PiBranchLifecycleStore,
} from "../../packages/pi-tai/src/core/subagents/lifecycle.ts";

const intent = {
  version: 1 as const,
  type: "spawn_intent" as const,
  durableId: "550e8400-e29b-41d4-a716-446655440000",
  displayId: "sa-7",
  sequence: 7,
  generation: 2,
  backend: "pi" as const,
  title: "work",
  cwd: "/tmp",
  at: "2026-01-01T00:00:00Z",
};

test("strict lifecycle fold restores identity, sequence, handle, and terminal state", () => {
  const folded = foldLifecycle([
    intent,
    {
      version: 1,
      type: "running",
      durableId: intent.durableId,
      generation: 2,
      at: "b",
      resumeHandle: { kind: "pi_session_file", value: "/private/session.jsonl" },
    },
    {
      version: 1,
      type: "terminal",
      durableId: intent.durableId,
      generation: 2,
      disposition: "done",
      at: "c",
    },
  ]);
  assert.equal(folded.maxSequence, 7);
  assert.equal(folded.records.get(intent.durableId)?.displayId, "sa-7");
  assert.equal(folded.records.get(intent.durableId)?.piSessionFile, "/private/session.jsonl");
  assert.equal(folded.records.get(intent.durableId)?.disposition, "done");
});

test("same-generation continuations fold from terminal back through running", () => {
  const folded = foldLifecycle([
    intent,
    {
      version: 1,
      type: "running",
      durableId: intent.durableId,
      generation: 2,
      at: "b",
    },
    {
      version: 1,
      type: "terminal",
      durableId: intent.durableId,
      generation: 2,
      disposition: "done",
      at: "c",
    },
    {
      version: 1,
      type: "running",
      durableId: intent.durableId,
      generation: 2,
      at: "d",
    },
    {
      version: 1,
      type: "terminal",
      durableId: intent.durableId,
      generation: 2,
      disposition: "failed",
      at: "e",
    },
  ]);

  assert.equal(folded.rejected.length, 0);
  assert.equal(folded.records.get(intent.durableId)?.disposition, "failed");
  assert.equal(folded.records.get(intent.durableId)?.updatedAt, "e");
});

test("unknown versions and invalid transitions are quarantined", () => {
  const folded = foldLifecycle([
    { ...intent, version: 0 },
    {
      version: 1,
      type: "terminal",
      durableId: "missing",
      generation: 1,
      disposition: "done",
      at: "x",
    },
  ]);
  assert.equal(folded.records.size, 0);
  assert.equal(folded.rejected.length, 2);
});

test("Pi adapter feature-detects persistence and folds getBranch only", async () => {
  const appended: unknown[] = [];
  const store = new PiBranchLifecycleStore(
    { appendEntry: (_type, data) => appended.push(data) },
    {
      getBranch: () => [
        { type: "pi-tai-subagent-lifecycle", data: intent },
        { type: "message", data: intent },
      ],
    },
  );
  assert.deepEqual(await store.load(), [intent]);
  await store.append(intent);
  assert.deepEqual(appended, [intent]);
  await assert.rejects(() => new PiBranchLifecycleStore({}, {}).append(intent), /cannot persist/);
});
