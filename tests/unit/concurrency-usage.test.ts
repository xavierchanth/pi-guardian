import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { FileChildContextStore, privateContextPaths, type PersistedChildContextV4 } from "../../packages/pi-tai/src/concurrency/persistence.ts";
import { ChildJournalRetention, ChildUsageLedger } from "../../packages/pi-tai/src/concurrency/usage.ts";

function context(id: string, parentContextId?: string): PersistedChildContextV4 {
  return {
    version: 4, contextId: id, rootSessionId: "root", ...(parentContextId ? { parentContextId } : {}), cwd: "/repo",
    task: { objective: "work", uncertaintyHandling: "best-effort" },
    agent: {
      name: "worker", description: "worker", root: false, provider: "faux", model: "scripted", effort: "low",
      tools: [], allowedChildren: [], uncertaintyHandling: "best-effort", systemPrompt: "work", source: "packaged", filePath: "worker.md", contentHash: "hash",
    },
    execution: { phase: "running", cycleId: `cycle-${id}`, startedAt: "now", sessionId: `session-${id}`, sessionFile: `/private/${id}.jsonl` },
    events: [], usage: [], createdAt: "now", updatedAt: "now",
  };
}

function assistant(id: string, input: number): AssistantMessage {
  return {
    role: "assistant", id, content: [], api: "faux", provider: "faux", model: "scripted", stopReason: "stop",
    usage: { input, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: input + 9, cost: { input: .01, output: .02, cacheRead: 0, cacheWrite: 0, total: .03 } },
    timestamp: 1,
  } as unknown as AssistantMessage;
}

test("usage ledger deduplicates intrinsic messages and aggregates descendants exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-usage-"));
  const store = new FileChildContextStore(join(root, "records"));
  await store.create(context("parent"));
  await store.create(context("child", "parent"));
  const ledger = new ChildUsageLedger(store, () => "time");
  await ledger.recordAssistant({ contextId: "parent", cycleId: "cycle-parent", role: "planner", provider: "faux", model: "one", message: assistant("m1", 10) });
  await ledger.recordAssistant({ contextId: "parent", cycleId: "cycle-parent", role: "planner", provider: "faux", model: "one", message: assistant("m1", 10) });
  await ledger.recordAssistant({ contextId: "child", cycleId: "cycle-child", role: "worker", provider: "faux", model: "two", message: assistant("m2", 20) });
  const totals = await ledger.totals("root", "parent");
  assert.equal(totals.total.input, 30);
  assert.equal(totals.total.output, 4);
  assert.equal(totals.byContext.parent.input, 10);
  assert.equal(totals.byContext.child.input, 20);
  assert.equal(totals.byModel["faux/one"].cost, .03);
});

test("journal cleanup requires terminal acknowledgement and closed workspace custody", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-retention-"));
  const stateRoot = join(root, "state");
  const store = new FileChildContextStore(join(stateRoot, "records"));
  const record = context("child");
  const terminal = {
    eventId: "event-1", contextId: "child", cycleId: "cycle-child", kind: "terminal" as const, payload: { outcome: "completed" },
    delivery: { phase: "acknowledged" as const, createdAt: "now", deliveredAt: "now", acknowledgedAt: "now" },
  };
  await store.create({ ...record, execution: { phase: "completed", cycleId: "cycle-child", terminalEventId: "event-1", finishedAt: "now" }, events: [terminal] });
  const paths = privateContextPaths(stateRoot, "child");
  await mkdir(paths.sessions, { recursive: true });
  await writeFile(join(paths.sessions, "session.jsonl"), "private");
  const retention = new ChildJournalRetention(store, stateRoot, () => "closed");
  await assert.rejects(retention.closeClean("child", false), /workspace custody/);
  await retention.closeClean("child", true);
  await assert.rejects(access(paths.root));
  assert.equal((await store.get("child"))?.closedAt, "closed");
});
