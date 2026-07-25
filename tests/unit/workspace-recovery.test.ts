import assert from "node:assert/strict";
import test from "node:test";
import { classifyWorkspaceRecovery, WorkspaceRecoveryPlanner, type WorkspaceRecoverySnapshot } from "../../packages/pi-tai/src/jj/workspace-recovery.ts";

const base: WorkspaceRecoverySnapshot = {
  version: 1,
  workspaceId: "workspace-1",
  custodyPhase: "active",
  attachment: { directory: "present", path: "/repo/.jj/workspaces/one" },
  graph: {
    expectedRootChangeId: "a".repeat(32),
    expectedHeadChangeId: "b".repeat(32),
    observedHeadChangeId: "b".repeat(32),
    observedHeadEmpty: true,
    orderedChangeIds: ["a".repeat(32), "b".repeat(32)],
    foreignDescendantIds: [],
    conflictPaths: [],
  },
  writerPhase: "available",
  observedJjOperationId: "op-1",
  discrepancies: [],
  evidenceDigest: "f".repeat(64),
};

function snapshot(patch: Partial<WorkspaceRecoverySnapshot>): WorkspaceRecoverySnapshot {
  return { ...base, ...patch };
}

test("workspace recovery classifies consistent and refreshable evidence", () => {
  assert.equal(classifyWorkspaceRecovery(base), "consistent");
  assert.equal(classifyWorkspaceRecovery(snapshot({ discrepancies: [{ kind: "operation_advanced", summary: "advanced" }] })), "refreshable");
});

test("workspace recovery classifies interrupted operation boundaries", () => {
  const operation = { operationId: "operation-1", kind: "workspace_checkpoint" as const, outcome: "started" as const, boundary: "prepared", beforeJjOperationId: "op-1" };
  assert.equal(classifyWorkspaceRecovery(snapshot({ writerPhase: "interrupted", latestOperation: operation })), "not_started");
  assert.equal(classifyWorkspaceRecovery(snapshot({ writerPhase: "interrupted", observedJjOperationId: "op-2", latestOperation: { ...operation, boundary: "mutating" } })), "resumable");
});

test("workspace recovery recognizes independently completed checkpoint", () => {
  assert.equal(classifyWorkspaceRecovery(snapshot({
    graph: { ...base.graph, observedHeadChangeId: "c".repeat(32), observedHeadEmpty: true },
    latestOperation: { operationId: "operation-1", kind: "workspace_checkpoint", outcome: "started", boundary: "verifying", beforeJjOperationId: "op-1" },
    observedJjOperationId: "op-2",
    discrepancies: [{ kind: "head_mismatch", summary: "changed" }],
  })), "completed_unrecorded");
});

test("workspace recovery preserves foreign and unknown states", () => {
  assert.equal(classifyWorkspaceRecovery(snapshot({ graph: { ...base.graph, foreignDescendantIds: ["c".repeat(32)] } })), "attention_required");
  assert.equal(classifyWorkspaceRecovery(snapshot({ discrepancies: [{ kind: "custody_uninspectable", summary: "bad" }] })), "attention_required");
});

test("workspace recovery plans deterministic automatic actions", () => {
  const planner = new WorkspaceRecoveryPlanner();
  const plan = planner.plan(snapshot({ attachment: { directory: "missing", path: base.attachment.path } }));
  assert.equal(plan.disposition, "reconstructable");
  assert.equal(plan.actions[0]?.automatic, true);
  assert.match(plan.planId, /^recovery-[a-f0-9]{64}$/);
});
