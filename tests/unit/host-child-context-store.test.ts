import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { HostConcurrencyRepository } from "../../packages/pi-tai/src/concurrency/host-repository.ts";
import { HostConcurrencyState } from "../../packages/pi-tai/src/concurrency/host-state.ts";
import { HostChildContextStore, type PersistedChildContextV4 } from "../../packages/pi-tai/src/concurrency/persistence.ts";
import { HostTaskStore, TaskService } from "../../packages/pi-tai/src/concurrency/tasks.ts";

class FakeHost {
  aggregate: any;
  async request(method: string, params: any): Promise<any> {
    if (method === "core.load") return this.aggregate;
    if (method !== "core.transact") throw new Error(method);
    const revision = (this.aggregate?.revision ?? 0) + 1;
    if (params.expectedRevision !== revision - 1) throw new Error(`revision conflict: ${revision - 1}`);
    this.aggregate = { aggregateId: "session:root-1:concurrency", revision, runtimeGeneration: 1, state: params.state, projection: params.projection, updatedAt: "now" };
    return this.aggregate;
  }
}

function context(): PersistedChildContextV4 {
  return {
    version: 4, contextId: "child-1", rootSessionId: "root-1", cwd: "/private/workspace",
    task: { objective: "Do work", uncertaintyHandling: "block" },
    agent: { name: "worker", description: "worker", root: false, provider: "p", model: "m", effort: "off", tools: [], allowedChildren: [], uncertaintyHandling: "block", systemPrompt: "private instructions", source: "packaged", filePath: "/private/agent.md", contentHash: "hash" },
    execution: { phase: "created", cycleId: "cycle-1" }, events: [], usage: [], telemetryGaps: [], createdAt: "now", updatedAt: "now",
  };
}

test("Host child store keeps private state out of bounded client projection", async () => {
  const host = new FakeHost();
  const store = new HostChildContextStore({ repository: new HostConcurrencyRepository(host), rootSessionId: "root-1", runtimeGeneration: 1, now: () => "now" });
  await store.create(context());
  assert.equal((await store.get("child-1"))?.cwd, "/private/workspace");
  assert.equal(host.aggregate.state.contexts[0].agent.systemPrompt, "private instructions");
  assert.equal(host.aggregate.projection.children[0].objective, "Do work");
  assert.equal(JSON.stringify(host.aggregate.projection).includes("private instructions"), false);
  assert.equal(JSON.stringify(host.aggregate.projection).includes("/private/workspace"), false);
  await store.update("child-1", (record) => ({ ...record, execution: { phase: "running", cycleId: "cycle-1", startedAt: "now", sessionId: "private-session", sessionFile: "/private/journal" } }));
  assert.equal((await store.get("child-1"))?.execution.phase, "running");
  assert.equal(JSON.stringify(host.aggregate.projection).includes("private-journal"), false);

  const hostState = new HostConcurrencyState({ repository: new HostConcurrencyRepository(host), rootSessionId: "root-1", runtimeGeneration: 1 });
  const tasks = new TaskService(new HostTaskStore(hostState), "/tmp/task-artifacts", () => "now");
  const content = "Implement durable work";
  const task = await tasks.createRoot({ rootSessionId: "root-1", orchestratorContextId: "orchestrator-1", objective: content, userRequest: { messageId: "user-1", content, contentHash: createHash("sha256").update(content).digest("hex"), observedAt: "now" } });
  assert.equal((await tasks.get(task.taskId))?.goal.objective, content);
  assert.equal((await store.get("child-1"))?.execution.phase, "running");
  assert.equal((host.aggregate.projection as any).tasks[0].objective, content);
  assert.equal(JSON.stringify(host.aggregate.projection).includes("user-1"), false);
});
