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

test("task plans expose effective revisions to executors and full history to orchestrator and reviewer", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-tasks-"));
  try {
    const store = new FileTaskStore(join(root, "records"));
    const service = new TaskService(store, join(root, "artifacts"));
    const task = await service.createRoot({
      rootSessionId: "root-1",
      orchestratorContextId: "orchestrator-1",
      objective: "Ship review gating",
      acceptanceCriteria: ["No stale review"],
      userRequest: user("Implement M4"),
    });
    await service.appendPlan(task.taskId, {
      authorContextId: "orchestrator-1",
      authorRole: "orchestrator",
      authorityMessageId: "user-1",
      markdown: "Implement with a reviewed isolated workspace",
      rationale: "Initial collaborative design",
    });
    await assert.rejects(service.approvePlan(task.taskId, { orchestratorContextId: "orchestrator-1", evidence: user("Implement M4") }), /distinct subsequent user message/);
    await assert.rejects(service.approvePlan(task.taskId, { orchestratorContextId: "orchestrator-1", evidence: user("I have another question", "user-question-1") }), /does not explicitly approve/);
    for (const [content, messageId] of [["Can you proceed with this plan?", "user-question-2"], ["Should we implement this plan?", "user-question-3"], ["Do you approve this plan?", "user-question-4"], ["I do not approve this plan", "user-rejection-1"], ["I approved the previous plan, but this one needs changes", "user-rejection-2"], ["This looks good, but wait before proceeding", "user-rejection-3"]] as const) await assert.rejects(service.approvePlan(task.taskId, { orchestratorContextId: "orchestrator-1", evidence: user(content, messageId) }), /does not explicitly approve/);
    const approval = await service.approvePlan(task.taskId, { orchestratorContextId: "orchestrator-1", evidence: user("I approve this plan", "user-approval-1") });
    assert.equal((await service.currentApproval(task.taskId))?.approvalId, approval.approvalId);
    const implementationLead = await service.assign(task.taskId, {
      ownerRole: "implementation-lead",
      creatorContextId: "orchestrator-1",
      objective: "Design integration",
    });
    await service.bind(implementationLead.taskId, "implementation-lead-1");
    await service.appendPlan(implementationLead.taskId, {
      authorContextId: "implementation-lead-1",
      authorRole: "implementation-lead",
      markdown: "1. Use the invalid approach",
      rationale: "Initial decomposition",
    });
    const redirected = await service.recordDirection(task.taskId, {
      orchestratorContextId: "orchestrator-1",
      evidence: user("Use the safe review path instead", "user-2"),
      summary: "Replace the unsafe plan",
    });
    const directionId = redirected.directions.at(-1)!.directionId;
    assert.equal(await service.currentApproval(task.taskId), undefined);
    assert.equal((await service.status(task.taskId, "orchestrator")).tasks.find((item) => item.taskId === task.taskId)?.currentApproval, undefined);
    await assert.rejects(service.requireCurrentImplementationApproval(implementationLead.taskId), /explicit user approval/);
    await assert.rejects(service.assign(task.taskId, { ownerRole: "documenter", creatorContextId: "orchestrator-1", objective: "Record redirected design" }), /explicit user approval/);
    await service.appendPlan(task.taskId, { authorContextId: "orchestrator-1", authorRole: "orchestrator", authorityMessageId: "user-2", markdown: "Use the redirected safe review path", rationale: "Applied user direction", directionIds: [directionId] });
    await assert.rejects(service.approvePlan(task.taskId, { orchestratorContextId: "orchestrator-1", evidence: user("I approve this plan", "user-approval-1") }), /distinct subsequent user message/);
    const redirectedApproval = await service.approvePlan(task.taskId, { orchestratorContextId: "orchestrator-1", evidence: user("Approved, go ahead", "user-approval-2") });
    assert.equal((await service.requireCurrentImplementationApproval(implementationLead.taskId))?.approvalId, redirectedApproval.approvalId);
    await assert.rejects(service.requireAssignmentApproval(implementationLead.taskId), /approval is stale/);
    await service.appendPlan(implementationLead.taskId, {
      authorContextId: "implementation-lead-1",
      authorRole: "implementation-lead",
      markdown: "1. Review\n2. Integrate safely",
      rationale: "Applied user redirection",
      directionIds: [directionId],
    });
    const worker = await service.assign(implementationLead.taskId, {
      ownerRole: "worker",
      creatorContextId: "implementation-lead-1",
      objective: "Implement integration",
    });
    await service.bind(worker.taskId, "worker-1");

    const plannerStatus = await service.status(implementationLead.taskId, "implementation-lead");
    assert.deepEqual(plannerStatus.tasks.map((item) => item.taskId), [implementationLead.taskId, worker.taskId]);
    assert.equal(JSON.stringify(plannerStatus).includes("invalid approach"), false);
    assert.equal(plannerStatus.directions.at(-1)?.directionId, directionId);
    assert.equal(plannerStatus.tasks[0]?.plan.state, "effective");
    if (plannerStatus.tasks[0]?.plan.state === "effective") {
      assert.match(plannerStatus.tasks[0].plan.revision.markdown, /Integrate safely/);
      assert.deepEqual(plannerStatus.tasks[0].plan.revision.directionIds, [directionId]);
    }

    const workerStatus = await service.status(worker.taskId, "worker");
    assert.deepEqual(workerStatus.tasks.map((item) => item.taskId), [task.taskId, implementationLead.taskId, worker.taskId]);
    assert.equal(JSON.stringify(workerStatus).includes("invalid approach"), false);
    assert.equal(workerStatus.tasks[1]?.plan.state, "effective");

    for (const role of ["orchestrator", "reviewer"] as const) {
      const status = await service.status(task.taskId, role);
      const plannerView = status.tasks.find((item) => item.taskId === implementationLead.taskId);
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

    await assert.rejects(service.appendPlan(implementationLead.taskId, {
      authorContextId: "implementation-lead-1",
      authorRole: "implementation-lead",
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
