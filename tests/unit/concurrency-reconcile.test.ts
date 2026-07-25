import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FileChildContextStore, type PersistedChildContextV4 } from "../../packages/pi-tai/src/concurrency/persistence.ts";
import { ChildContextReconciler, classifyContext, type ReconciliationCoordinator } from "../../packages/pi-tai/src/concurrency/reconcile.ts";
import { ChildEventWaitRegistry } from "../../packages/pi-tai/src/concurrency/waits.ts";

function record(id: string, parentContextId?: string): PersistedChildContextV4 {
  return {
    version: 4, contextId: id, rootSessionId: "root", ...(parentContextId ? { parentContextId } : {}), cwd: "/repo",
    task: { objective: id, uncertaintyHandling: "best-effort" },
    agent: {
      name: "worker", description: "worker", root: false, provider: "faux", model: "scripted", effort: "low", tools: [], allowedChildren: [],
      uncertaintyHandling: "best-effort", systemPrompt: "work", source: "packaged", filePath: "worker.md", contentHash: "hash",
    },
    execution: { phase: "interrupted", cycleId: `old-${id}`, reason: "root restart", interruptedAt: "before", sessionFile: `/private/${id}.jsonl` },
    events: [], usage: [], telemetryGaps: [], createdAt: "before", updatedAt: "before",
  };
}

test("reconciler resumes descendants before parents and clears active waits", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-reconcile-"));
  const store = new FileChildContextStore(join(root, "records"));
  await store.create(record("parent"));
  await store.create(record("child", "parent"));
  const order: string[] = [];
  const coordinator: ReconciliationCoordinator = {
    getRuntime: () => undefined,
    resume: async (input) => {
      order.push(input.contextId);
      return store.update(input.contextId, (current) => ({
        ...current,
        execution: { phase: "running", cycleId: `new-${input.contextId}`, startedAt: "now", sessionId: `session-${input.contextId}`, sessionFile: `/private/${input.contextId}.jsonl` },
      }));
    },
  };
  const waits = new ChildEventWaitRegistry();
  const pending = waits.wait({ callerId: "root" });
  const reconciler = new ChildContextReconciler({ store, coordinator, waits, now: () => "now" });
  const result = await reconciler.reconcile({ rootSessionId: "root", modelRegistry: {} as ExtensionContext["modelRegistry"] });
  assert.deepEqual(order, ["child", "parent"]);
  assert.deepEqual(result.map((item) => [item.contextId, item.depth, item.disposition]), [
    ["child", 1, "resumed"],
    ["parent", 0, "resumed"],
  ]);
  assert.deepEqual(await pending, { reason: "cancelled" });
});

test("classifier excludes terminal/cancelled and stops ambiguous mutation incidents", () => {
  assert.equal(classifyContext({ ...record("done"), execution: { phase: "completed", cycleId: "c", terminalEventId: "e", finishedAt: "now" } }, false), "terminal");
  assert.equal(classifyContext({ ...record("cancel"), execution: { phase: "cancelled", cycleId: "c", terminalEventId: "e", finishedAt: "now" } }, false), "cancelled");
  const cancelling = { ...record("cancelling"), execution: { phase: "cancelling" as const, cycleId: "c", requestedAt: "now", reason: "parent request" } };
  assert.equal(classifyContext(cancelling, true), "cancellation_pending");
  assert.equal(classifyContext(cancelling, false), "mutation_stopped");
  assert.equal(classifyContext({ ...record("incident"), execution: { phase: "incident", cycleId: "c", reason: "writer quiescence unknown", stoppedAt: "now" } }, false), "mutation_stopped");
});
