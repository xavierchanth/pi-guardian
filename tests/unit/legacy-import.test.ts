import assert from "node:assert/strict";
import test from "node:test";
import { planLegacyContextImport } from "../../packages/pi-tai/src/concurrency/legacy-import.ts";
import type { DelegationRecord } from "../../packages/pi-tai/src/subagents/store.ts";

function legacy(id: string, phase: "created" | "running" | "completed" | "abandoned" = "created"): DelegationRecord {
  const execution: DelegationRecord["execution"] = phase === "created" ? { phase } : phase === "running" ? { phase } : phase === "abandoned" ? { phase, reason: "stopped" } : { phase, report: { outcome: phase, summary: "done", reportedAt: "2026-01-01T00:00:00Z" } };
  return {
    version: 3, id, parentSessionId: "legacy-parent", cwd: "/repo", task: { objective: "work", uncertaintyHandling: "best-effort" },
    agent: { name: "worker", description: "worker", root: false, provider: "faux", model: "model", effort: "low", tools: [], allowedChildren: [], uncertaintyHandling: "best-effort", systemPrompt: "work", source: "packaged", filePath: "worker.md", contentHash: "hash" },
    execution, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
}

test("one-way legacy import accepts only quiescent identity-proved records", () => {
  const created = legacy("child-created");
  const running = { ...legacy("child-running", "running"), pid: 42 } as unknown as DelegationRecord;
  const terminal = legacy("child-terminal", "completed");
  const plan = planLegacyContextImport({ records: [created, running, terminal], existing: [], rootSessionId: "root-1", now: "2026-02-01T00:00:00Z" });
  assert.deepEqual(plan.imports.map((record) => [record.contextId, record.execution.phase, record.rootSessionId]), [["child-created", "created", "root-1"]]);
  assert.deepEqual(plan.quarantines.map((entry) => entry.reason), ["subprocess_state", "execution_identity_missing"]);
  assert.equal(JSON.stringify(plan.imports).includes("legacy-parent"), false);
});

test("one-way legacy import skips proved prior imports and quarantines conflicting mirrors", () => {
  const first = planLegacyContextImport({ records: [legacy("child-1")], existing: [], rootSessionId: "root-1", now: "2026-02-01T00:00:00Z" }).imports[0]!;
  const skipped = planLegacyContextImport({ records: [legacy("child-1")], existing: [first], rootSessionId: "root-1", now: "later" });
  assert.deepEqual(skipped.skippedExistingIds, ["child-1"]);
  const conflicting = planLegacyContextImport({ records: [{ ...legacy("child-1"), task: { objective: "different", uncertaintyHandling: "best-effort" } }], existing: [first], rootSessionId: "root-1", now: "later" });
  assert.equal(conflicting.quarantines[0]?.reason, "conflicting_mirror");
});
