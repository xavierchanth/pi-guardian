import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileTaskStore, TaskService } from "../../packages/pi-tai/src/concurrency/tasks.ts";

function user(content: string, messageId = "user-1") {
  return {
    messageId,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    observedAt: "2026-01-01T00:00:00Z",
  };
}

test("task plans expose effective revisions to executors and full history to thinker and reviewer", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-tasks-"));
  try {
    const store = new FileTaskStore(join(root, "records"));
    const service = new TaskService(store, join(root, "artifacts"));
    const task = await service.createRoot({
      rootSessionId: "root-1",
      thinkerContextId: "thinker-1",
      objective: "Ship review gating",
      acceptanceCriteria: ["No stale review"],
      userRequest: user("Implement M4"),
    });
    const planner = await service.assign(task.taskId, {
      ownerRole: "planner",
      creatorContextId: "thinker-1",
      objective: "Design integration",
    });
    await service.bind(planner.taskId, "planner-1");
    await service.appendPlan(planner.taskId, {
      authorContextId: "planner-1",
      authorRole: "planner",
      markdown: "1. Use the invalid approach",
      rationale: "Initial decomposition",
    });
    const redirected = await service.recordDirection(task.taskId, {
      thinkerContextId: "thinker-1",
      evidence: user("Use the safe review path instead", "user-2"),
      summary: "Replace the unsafe plan",
    });
    const directionId = redirected.directions.at(-1)!.directionId;
    await service.appendPlan(planner.taskId, {
      authorContextId: "planner-1",
      authorRole: "planner",
      markdown: "1. Review\n2. Integrate safely",
      rationale: "Applied user redirection",
      directionIds: [directionId],
    });
    const worker = await service.assign(planner.taskId, {
      ownerRole: "worker",
      creatorContextId: "planner-1",
      objective: "Implement integration",
    });
    await service.bind(worker.taskId, "worker-1");

    const plannerStatus = await service.status(planner.taskId, "planner");
    assert.deepEqual(plannerStatus.tasks.map((item) => item.taskId), [planner.taskId, worker.taskId]);
    assert.equal(JSON.stringify(plannerStatus).includes("invalid approach"), false);
    assert.equal(plannerStatus.directions.at(-1)?.directionId, directionId);
    assert.equal(plannerStatus.tasks[0]?.plan.state, "effective");
    if (plannerStatus.tasks[0]?.plan.state === "effective") {
      assert.match(plannerStatus.tasks[0].plan.revision.markdown, /Integrate safely/);
      assert.deepEqual(plannerStatus.tasks[0].plan.revision.directionIds, [directionId]);
    }

    const workerStatus = await service.status(worker.taskId, "worker");
    assert.deepEqual(workerStatus.tasks.map((item) => item.taskId), [task.taskId, planner.taskId, worker.taskId]);
    assert.equal(JSON.stringify(workerStatus).includes("invalid approach"), false);
    assert.equal(workerStatus.tasks[1]?.plan.state, "effective");

    for (const role of ["thinker", "reviewer"] as const) {
      const status = await service.status(task.taskId, role);
      const plannerView = status.tasks.find((item) => item.taskId === planner.taskId);
      assert.equal(plannerView?.plan.state, "full");
      if (plannerView?.plan.state === "full") {
        assert.deepEqual(plannerView.plan.revisions.map((item) => item.authority), ["superseded", "current"]);
        assert.match(plannerView.plan.revisions[0]!.markdown, /invalid approach/);
      }
    }

    const snapshot = await service.snapshot(worker.taskId);
    const markdown = await readFile(snapshot.path, "utf8");
    assert.match(snapshot.digest, /^[a-f0-9]{64}$/);
    assert.match(markdown, /Superseded plan revision[\s\S]*invalid approach/);
    assert.match(markdown, /Current plan revision[\s\S]*Integrate safely/);
    assert.match(markdown, new RegExp(`Directions: ${directionId}`));

    await assert.rejects(service.appendPlan(planner.taskId, {
      authorContextId: "planner-1",
      authorRole: "planner",
      markdown: "Unknown redirect",
      rationale: "Invalid provenance",
      directionIds: ["direction-unknown"],
    }), /Unknown user direction/);
    await assert.rejects(store.update(task.taskId, (record) => ({
      ...record,
      goal: { ...record.goal, objective: "rewritten" },
    })), /cannot rewrite goal/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
