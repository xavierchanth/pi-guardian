import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FileChildContextStore,
  privateContextPaths,
  validateContextRecord,
  type PersistedChildContextV4,
} from "../../packages/pi-tai/src/concurrency/persistence.ts";

function fixture(): PersistedChildContextV4 {
  return {
    version: 4,
    contextId: "child-1",
    rootSessionId: "root-1",
    cwd: "/repo",
    task: { objective: "Do work", uncertaintyHandling: "best-effort" },
    agent: {
      name: "worker", description: "worker", root: false, provider: "faux", model: "scripted",
      effort: "low", tools: [], allowedChildren: [], uncertaintyHandling: "best-effort",
      systemPrompt: "work", source: "packaged", filePath: "worker.md", contentHash: "hash",
    },
    execution: { phase: "created", cycleId: "cycle-1" },
    events: [],
    usage: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

test("v4 context store round trips and preserves identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-context-store-"));
  const store = new FileChildContextStore(join(root, "delegations"));
  await store.create(fixture());
  assert.deepEqual(await store.get("child-1"), fixture());
  const updated = await store.update("child-1", (record) => ({ ...record, updatedAt: "2026-01-01T00:00:01Z" }));
  assert.equal(updated.updatedAt, "2026-01-01T00:00:01Z");
  assert.deepEqual((await store.listChildren("root-1")).map((item) => item.contextId), ["child-1"]);
  await assert.rejects(store.update("child-1", (record) => ({ ...record, contextId: "other" })), /cannot change identity/);
});

test("v4 validation quarantines invalid lifecycle combinations", () => {
  assert.throws(() => validateContextRecord({ ...fixture(), version: 3 }), /version 4/);
  assert.throws(() => validateContextRecord({
    ...fixture(), execution: { phase: "running", cycleId: "cycle-1" },
  }), /requires session identity/);
  assert.throws(() => validateContextRecord({
    ...fixture(), execution: { phase: "completed", cycleId: "cycle-1", finishedAt: "now" },
  }), /requires terminalEventId/);
});

test("private context paths are exact and traversal-safe", () => {
  assert.deepEqual(privateContextPaths("/state/subagents", "child-1"), {
    root: "/state/subagents/contexts/child-1",
    sessions: "/state/subagents/contexts/child-1/sessions",
    artifacts: "/state/subagents/contexts/child-1/artifacts",
  });
  assert.throws(() => privateContextPaths("/state/subagents", "../escape"), /Invalid managed context ID/);
});
