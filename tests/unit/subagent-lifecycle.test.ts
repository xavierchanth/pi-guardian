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

test("v2 advances generations exactly once and binds handles to their backend", () => {
  const v2 = {
    version: 2 as const,
    type: "spawn_intent" as const,
    durableId: "v2-id",
    displayId: "sa-8",
    sequence: 8,
    generation: 1,
    backend: "claude" as const,
    title: "work",
    backendConfig: { model: "sonnet" },
    workspace: { cwd: "/work", workspaceId: "ws" },
    capability: "researcher" as const,
    audience: "manager" as const,
    at: "a",
  };
  const folded = foldLifecycle([
    v2,
    { version: 2, type: "running", durableId: "v2-id", generation: 1, at: "b" },
    {
      version: 2,
      type: "resume_handle_discovered",
      durableId: "v2-id",
      generation: 1,
      resumeHandle: { kind: "claude_session", value: "session" },
      at: "c",
    },
    {
      version: 2,
      type: "terminal",
      durableId: "v2-id",
      generation: 1,
      disposition: "done",
      at: "d",
    },
    {
      version: 2,
      type: "generation_advanced",
      durableId: "v2-id",
      previousGeneration: 1,
      generation: 2,
      at: "e",
    },
    { version: 2, type: "running", durableId: "v2-id", generation: 2, at: "f" },
    {
      version: 2,
      type: "generation_advanced",
      durableId: "v2-id",
      previousGeneration: 2,
      generation: 3,
      at: "bad",
    },
    {
      version: 2,
      type: "resume_handle_discovered",
      durableId: "v2-id",
      generation: 2,
      resumeHandle: { kind: "codex_thread", value: "wrong" },
      at: "bad2",
    },
  ]);
  const record = folded.records.get("v2-id");
  assert.equal(record?.generation, 2);
  assert.equal(record?.disposition, "running");
  assert.deepEqual(record?.resumeHandle, { kind: "claude_session", value: "session" });
  assert.equal(record?.workspaceId, "ws");
  assert.equal(folded.rejected.length, 2);
});

test("v2 future facts preserve charter, report, delivery, attachments, and archival state", () => {
  const base = {
    version: 2 as const,
    type: "spawn_intent" as const,
    durableId: "future",
    displayId: "sa-9",
    sequence: 9,
    generation: 1,
    backend: "pi" as const,
    title: "future",
    backendConfig: {},
    workspace: { cwd: "/work" },
    at: "a",
  };
  const folded = foldLifecycle([
    base,
    {
      version: 2,
      type: "charter",
      durableId: "future",
      generation: 1,
      charter: "do work",
      audience: "manager",
      at: "b",
    },
    { version: 2, type: "running", durableId: "future", generation: 1, at: "c" },
    {
      version: 2,
      type: "terminal",
      durableId: "future",
      generation: 1,
      disposition: "cancelled",
      report: "stopped",
      delivery: "pending",
      audience: "user",
      attachments: [{ kind: "artifact", ref: "sha256:abc" }],
      at: "d",
    },
    {
      version: 2,
      type: "result_consumed",
      durableId: "future",
      generation: 1,
      audience: "user",
      at: "e",
    },
    { version: 2, type: "archived", durableId: "future", generation: 1, at: "f" },
  ]);
  const record = folded.records.get("future");
  assert.equal(folded.rejected.length, 0);
  assert.equal(record?.charter, "do work");
  assert.equal(record?.report, "stopped");
  assert.equal(record?.consumed, true);
  assert.equal(record?.disposition, "archived");
  assert.deepEqual(record?.attachments, [{ kind: "artifact", ref: "sha256:abc" }]);
});

test("unknown and malformed fields are quarantined rather than dropped", () => {
  const folded = foldLifecycle([
    { ...intent, surprise: true },
    { ...intent, type: "running", resumeHandle: { kind: "pi_session_file", value: " padded " } },
  ]);
  assert.equal(folded.records.size, 0);
  assert.equal(folded.rejected.length, 2);
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
