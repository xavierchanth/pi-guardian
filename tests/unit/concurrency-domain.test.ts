import assert from "node:assert/strict";
import test from "node:test";
import { changeId } from "../../packages/pi-tai/src/jj/domain.ts";
import {
  acknowledgeChildEvent,
  attributeUsage,
  canonicalFileSet,
  interruptFileSetClaim,
  interruptWorkspaceWriter,
  type ChildEventAcknowledgement,
  type FileSetClaim,
  type UsageAttribution,
  type WorkspaceWriterToken,
} from "../../packages/pi-tai/src/concurrency/domain.ts";
import {
  childContextId,
  childEventId,
  executionCycleId,
  fileSetClaimId,
  jjOperationId,
  rootSessionId,
  usageEventId,
  workspaceId,
} from "../../packages/pi-tai/src/concurrency/ids.ts";
import { migrateDelegationRecord } from "../../packages/pi-tai/src/concurrency/migration.ts";

test("child event acknowledgement and usage attribution are idempotent", () => {
  const pending: ChildEventAcknowledgement = {
    phase: "pending",
    eventId: childEventId("event-1"),
    emittedAt: "2026-01-01T00:00:00Z",
  };
  const acknowledged = acknowledgeChildEvent(pending, "2026-01-01T00:00:01Z");
  assert.equal(acknowledged.phase, "acknowledged");
  assert.equal(acknowledgeChildEvent(acknowledged, "2026-01-01T00:00:02Z"), acknowledged);

  const usage: UsageAttribution = {
    phase: "pending",
    event: {
      eventId: usageEventId("usage-1"),
      contextId: childContextId("child-1"),
      cycleId: executionCycleId("cycle-1"),
      provider: "provider",
      model: "model",
      role: "worker",
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.01 },
    },
  };
  const attributed = attributeUsage(usage, rootSessionId("root-1"), "2026-01-01T00:00:03Z");
  assert.equal(attributed.phase, "attributed");
  assert.equal(attributeUsage(attributed, rootSessionId("other-root"), "later"), attributed);
});

test("restart interrupts live claims and workspace writers without preserving ownership", () => {
  const claim: FileSetClaim = {
    phase: "checkpointing",
    claimId: fileSetClaimId("claim-1"),
    owner: childContextId("child-1"),
    fileSet: canonicalFileSet(["src/b.ts", "./src/a.ts", "src/a.ts"]),
    operationId: jjOperationId("operation-1"),
  };
  assert.deepEqual(claim.fileSet.paths, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(interruptFileSetClaim(claim, "root restart"), {
    phase: "interrupted",
    claimId: claim.claimId,
    priorPhase: "checkpointing",
    reason: "root restart",
  });
  assert.throws(() => canonicalFileSet([]), /at least one path/);
  assert.throws(() => canonicalFileSet(["../outside"]), /Invalid repository-relative path/);

  const writer: WorkspaceWriterToken = {
    phase: "checkpointing",
    workspaceId: workspaceId("workspace-1"),
    owner: childContextId("child-1"),
    expectedHeadChangeId: changeId("a".repeat(32)),
    operationId: jjOperationId("operation-2"),
  };
  assert.deepEqual(interruptWorkspaceWriter(writer), {
    phase: "interrupted",
    workspaceId: writer.workspaceId,
    priorOwner: writer.owner,
    expectedHeadChangeId: writer.expectedHeadChangeId,
  });

  const rebasing: WorkspaceWriterToken = {
    phase: "rebasing",
    workspaceId: workspaceId("workspace-1"),
    owner: childContextId("thinker-1"),
    rootChangeId: changeId("b".repeat(32)),
    expectedHeadChangeId: changeId("c".repeat(32)),
    operationId: jjOperationId("operation-3"),
  };
  assert.deepEqual(interruptWorkspaceWriter(rebasing), {
    phase: "interrupted",
    workspaceId: rebasing.workspaceId,
    priorOwner: rebasing.owner,
    expectedHeadChangeId: rebasing.expectedHeadChangeId,
  });
});

test("legacy delegation migration loads safe dormant intent and quarantines unproved writers", () => {
  const base = {
    version: 3,
    id: "child-1",
    parentSessionId: "root-1",
    cwd: "/repo",
    task: { objective: "Implement the bounded slice" },
    agent: { name: "worker" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:01Z",
  };
  const loaded = migrateDelegationRecord({ ...base, execution: { phase: "created" } });
  assert.equal(loaded.kind, "loaded");
  if (loaded.kind === "loaded") {
    assert.equal(loaded.record.execution.phase, "created");
    assert.equal(loaded.record.intent.cwdKind, "source");
    assert.equal(loaded.record.intent.objective, "Implement the bounded slice");
  }

  const quarantined = migrateDelegationRecord({
    ...base,
    childPid: 123,
    execution: { phase: "running", activity: "editing" },
  });
  assert.deepEqual(quarantined, {
    kind: "quarantined",
    sourceVersion: 3,
    reason: "live_writer_unproven",
    detail: "Legacy running execution has no durable execution-cycle identity or quiescence proof.",
  });
});
