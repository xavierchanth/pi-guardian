import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { changeId, workspaceId, workspaceName } from "../../packages/pi-tai/src/jj/domain.ts";
import { IsolatedJjRuntime } from "../../packages/pi-tai/src/jj/isolated-runtime.ts";
import type { IsolatedWorkspaceStore, PersistedIsolatedWorkspaceV1 } from "../../packages/pi-tai/src/jj/workspace-persistence.ts";
import type { JjWorkspaceRepositoryKernel } from "../../packages/pi-tai/src/jj/workspace-repository.ts";
import { RealJjFixture } from "../support/real-jj-fixture.ts";
import { classifyWorkspaceRecovery, WorkspaceRecoveryInspector, WorkspaceRecoveryPlanner, type WorkspaceRecoverySnapshot } from "../../packages/pi-tai/src/jj/workspace-recovery.ts";

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

function recoveryInspectionHarness(
  failingInspection: "range" | "foreignDescendants",
  custodyPhase: "active" | "cleanup_pending",
) {
  const id = workspaceId("workspace-1");
  const rootChangeId = "a".repeat(32);
  const headChangeId = "b".repeat(32);
  const identity = {
    workspaceId: id,
    rootSessionId: "root-1",
    sourceId: "source-1",
    sourceWipChangeId: "c".repeat(32),
    baseChangeId: "d".repeat(32),
    name: "recovery-test",
    path: process.cwd(),
    rootChangeId,
    expectedHeadChangeId: headChangeId,
  };
  const timestamps = {
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const record: PersistedIsolatedWorkspaceV1 = custodyPhase === "active"
    ? {
      version: 1,
      phase: "active",
      identity,
      writer: { phase: "available", headChangeId, generation: 1 },
      targets: [],
      claims: [],
      operations: [],
      ...timestamps,
    }
    : {
      version: 1,
      phase: "cleanup_pending",
      identity,
      outcome: "closed",
      semanticReceipt: {},
      reason: "cleanup interrupted",
      ...timestamps,
    };
  const store = {
    async get(candidate: string) { return candidate === id ? record : undefined; },
  } as IsolatedWorkspaceStore;
  const inspectionError = new Error(`${failingInspection} inspection failed`);
  const repository = {
    async inspect() {
      return {
        identity,
        head: {
          changeId: changeId(headChangeId),
          commitId: "e".repeat(40),
          empty: true,
          conflicted: false,
          immutable: false,
          parentChangeIds: [changeId(rootChangeId)],
          description: "",
        },
        operationId: "operation-1",
      };
    },
    async range() {
      if (failingInspection === "range") throw inspectionError;
      return [];
    },
    async foreignDescendants() {
      if (failingInspection === "foreignDescendants") throw inspectionError;
      return [];
    },
    async conflicts() { return []; },
  } as unknown as JjWorkspaceRepositoryKernel;
  return { id, inspector: new WorkspaceRecoveryInspector(store, repository), inspectionError };
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

for (const failingInspection of ["range", "foreignDescendants"] as const) {
  for (const custodyPhase of ["active", "cleanup_pending"] as const) {
    test(`workspace recovery fails closed when ${failingInspection} inspection fails during ${custodyPhase}`, async () => {
      const { id, inspector, inspectionError } = recoveryInspectionHarness(failingInspection, custodyPhase);
      const inspected = await inspector.inspect(id);
      const discrepancy = inspected.discrepancies.find((item) => item.kind === "custody_uninspectable");
      assert.ok(discrepancy);
      assert.match(discrepancy.summary, new RegExp(inspectionError.message));

      const plan = new WorkspaceRecoveryPlanner().plan(inspected);
      assert.equal(plan.disposition, "attention_required");
      assert.deepEqual(plan.actions.map((action) => action.automatic), [false]);
      assert.deepEqual(plan.actions.map((action) => action.kind), ["preserve_incident"]);
    });
  }
}

test("workspace recovery plans deterministic automatic actions", () => {
  const implementationLead = new WorkspaceRecoveryPlanner();
  const plan = implementationLead.plan(snapshot({ attachment: { directory: "missing", path: base.attachment.path } }));
  assert.equal(plan.disposition, "reconstructable");
  assert.equal(plan.actions[0]?.automatic, true);
  assert.match(plan.planId, /^recovery-[a-f0-9]{64}$/);
});

test("workspace recovery reconstructs an exact missing managed attachment", async () => {
  const fixture = await RealJjFixture.create("pi-tai-reconstruct-attachment-");
  try {
    await fixture.seed({ changes: [{ description: "base", files: { "base.txt": "base\n" } }] });
    const runtime = new IsolatedJjRuntime({ stateRoot: join(fixture.root, "state"), executor: fixture.executor }); const source = await runtime.shared.openSource(fixture.repoPath); await runtime.shared.operations.ensureWip(source);
    const created = await runtime.operations.createWorkspace(source, { name: workspaceName("reconstruct"), ownerContextId: "worker-1", rootSessionId: "root-1" }); if (created.kind !== "completed") throw new Error(); await runtime.operations.releaseWriter(created.receipt.lease);
    await rm(created.receipt.path, { recursive: true, force: true }); const before = await runtime.recoveryInspector.inspect(created.receipt.workspaceId); assert.equal(runtime.recoveryPlanner.plan(before).disposition, "reconstructable");
    const receipt = await runtime.operations.reconstructWorkspaceAttachment(created.receipt.workspaceId); assert.equal(receipt.reconstructed, true); assert.notEqual(receipt.headChangeId, created.receipt.workspaceHeadChangeId);
    const after = await runtime.recoveryInspector.inspect(created.receipt.workspaceId); assert.equal(after.attachment.directory, "present"); assert.equal(after.graph.expectedHeadChangeId, receipt.headChangeId);
  } finally { await fixture.dispose(); }
});
