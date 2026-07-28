import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { childContextId } from "../../packages/pi-tai/src/concurrency/ids.ts";
import { changeDescription, workspaceId, workspaceName, workspaceRebaseLease, workspaceWriteLeaseId } from "../../packages/pi-tai/src/jj/domain.ts";
import { IsolatedJjRuntime } from "../../packages/pi-tai/src/jj/isolated-runtime.ts";
import { RealJjFixture } from "../support/real-jj-fixture.ts";

test("tracked isolated workspace allocates, checkpoints with a fresh lease, and freezes", async () => {
  const fixture = await RealJjFixture.create("pi-tai-isolated-ops-");
  try {
    await fixture.seed({ changes: [{ description: "base", files: { "base.txt": "base\n" } }] });
    const runtime = new IsolatedJjRuntime({ stateRoot: join(fixture.root, "state"), executor: fixture.executor });
    const source = await runtime.shared.openSource(fixture.repoPath);
    await writeFile(join(fixture.repoPath, "source-wip.txt"), "preserve me\n");
    const sourceIdBefore = await fixture.currentChangeId(fixture.repoPath); const sourceDiffBefore = await fixture.run(fixture.repoPath, ["diff", "--revision", "@", "--git"]);
    const created = await runtime.operations.createWorkspace(source, { name: workspaceName("planned"), ownerContextId: childContextId("child-1"), rootSessionId: "root-1" }); assert.equal(created.kind, "completed"); if (created.kind !== "completed") return;
    assert.equal(await fixture.currentChangeId(fixture.repoPath), sourceIdBefore); assert.equal(await fixture.run(fixture.repoPath, ["diff", "--revision", "@", "--git"]), sourceDiffBefore);
    await writeFile(join(created.receipt.path, "feature.txt"), "feature\n");
    const checkpoint = await runtime.operations.checkpointWorkspace(created.receipt.lease, { description: changeDescription("feat: add feature") }); assert.equal(checkpoint.kind, "completed"); if (checkpoint.kind !== "completed") return;
    assert.notEqual(checkpoint.receipt.lease.leaseId, created.receipt.lease.leaseId);
    await runtime.operations.releaseWriter(checkpoint.receipt.lease);
    const rebased = await runtime.operations.rebaseWorkspace(workspaceRebaseLease(created.receipt.workspaceId, workspaceWriteLeaseId("rebase-1")), { kind: "source_parent" }); assert.equal(rebased.kind, "completed");
    const report = await runtime.operations.prepareWorkspaceReport(created.receipt.workspaceId); assert.equal(report.kind, "completed"); if (report.kind === "completed") assert.equal(report.receipt.range, "nonempty");
    const stored = await runtime.workspaces.get(created.receipt.workspaceId); assert.equal(stored?.phase, "reported"); assert.equal("writer" in (stored ?? {}), false);
  } catch (error) { const retained = await fixture.retainOnFailure("isolated operations"); if (error instanceof Error) error.message += `\nRetained fixture: ${retained.path}`; throw error; }
  finally { await fixture.dispose(); }
});

test("workspace allocation and source-parent rebase resolve source revisions only at operation time", async () => {
  const fixture = await RealJjFixture.create("pi-tai-isolated-moving-source-");
  try {
    await fixture.seed({ changes: [{ description: "base", files: { "base.txt": "base\n" } }] });
    const runtime = new IsolatedJjRuntime({ stateRoot: join(fixture.root, "state"), executor: fixture.executor });
    const source = await runtime.shared.openSource(fixture.repoPath);
    await writeFile(join(fixture.repoPath, "external-before.txt"), "before allocation\n");
    await fixture.run(fixture.repoPath, ["describe", "--message", "feat: external checkpoint before allocation"], "write");
    await fixture.run(fixture.repoPath, ["new"], "write");
    const allocationParent = await fixture.run(fixture.repoPath, ["log", "--revision", "@-", "--no-graph", "--template", 'change_id ++ "\\n"']);
    const created = await runtime.operations.createWorkspace(source, { name: workspaceName("moving-source"), ownerContextId: "child-moving", rootSessionId: "root-1" });
    assert.equal(created.kind, "completed"); if (created.kind !== "completed") return;
    assert.equal(await fixture.run(created.receipt.path, ["log", "--revision", "@-", "--no-graph", "--template", 'change_id ++ "\\n"']), allocationParent);
    await runtime.operations.releaseWriter(created.receipt.lease);
    await writeFile(join(fixture.repoPath, "external-after.txt"), "before rebase\n");
    await fixture.run(fixture.repoPath, ["describe", "--message", "feat: external checkpoint before rebase"], "write");
    await fixture.run(fixture.repoPath, ["new"], "write");
    const rebaseParent = await fixture.run(fixture.repoPath, ["log", "--revision", "@-", "--no-graph", "--template", 'change_id ++ "\\n"']);
    const rebased = await runtime.operations.rebaseWorkspace(workspaceRebaseLease(created.receipt.workspaceId, workspaceWriteLeaseId("moving-source-rebase")), { kind: "source_parent" });
    assert.equal(rebased.kind, "completed");
    assert.equal(await fixture.run(created.receipt.path, ["log", "--revision", `parents(exactly(change_id(${created.receipt.rootChangeId}), 1))`, "--no-graph", "--template", 'change_id ++ "\\n"']), rebaseParent);
    const tracked = await runtime.workspaces.get(created.receipt.workspaceId);
    if (tracked?.phase === "active") {
      assert.equal(tracked.identity.sourceWipChangeId, undefined);
      assert.equal(tracked.identity.baseChangeId, undefined);
    }
  } finally { await fixture.dispose(); }
});

test("interrupted allocation adopts exactly one matching workspace without a writer", async () => {
  const fixture = await RealJjFixture.create("pi-tai-isolated-allocation-recovery-"); let interrupt = true;
  try {
    await fixture.seed({ changes: [{ description: "base", files: { "base.txt": "base\n" } }] }); const runtime = new IsolatedJjRuntime({ stateRoot: join(fixture.root, "state"), executor: fixture.executor, failpoint: (operation, boundary) => { if (interrupt && operation === "allocate_workspace" && boundary === "after_mutation") { interrupt = false; throw new Error("injected allocation interruption"); } } }); const source = await runtime.shared.openSource(fixture.repoPath);
    await assert.rejects(runtime.operations.createWorkspace(source, { name: workspaceName("alloc-recover"), ownerContextId: "child-a", rootSessionId: "root-1" }), /injected/); const incident = (await runtime.workspaces.list()).find((item) => item.phase === "incident"); assert.ok(incident && incident.phase === "incident"); if (!incident || incident.phase !== "incident") return; assert.equal(await runtime.operations.reconcileAllocation(workspaceId(incident.workspaceId)), "completed"); const recovered = await runtime.workspaces.get(incident.workspaceId); assert.equal(recovered?.phase, "active"); if (recovered?.phase === "active") assert.equal(recovered.writer.phase, "available");
  } finally { await fixture.dispose(); }
});

test("interrupted checkpoint reconstructs its exact completed head transition", async () => {
  const fixture = await RealJjFixture.create("pi-tai-isolated-recovery-"); let interrupt = true;
  try {
    await fixture.seed({ changes: [{ description: "base", files: { "base.txt": "base\n" } }] });
    const runtime = new IsolatedJjRuntime({ stateRoot: join(fixture.root, "state"), executor: fixture.executor, failpoint: (operation, boundary) => { if (interrupt && operation === "workspace_checkpoint" && boundary === "after_new") { interrupt = false; throw new Error("injected interruption"); } } });
    const source = await runtime.shared.openSource(fixture.repoPath);
    const created = await runtime.operations.createWorkspace(source, { name: workspaceName("recover"), ownerContextId: "child-r", rootSessionId: "root-1" }); assert.equal(created.kind, "completed"); if (created.kind !== "completed") return;
    await writeFile(join(created.receipt.path, "recover.txt"), "recover\n"); const stopped = await runtime.operations.checkpointWorkspace(created.receipt.lease, { description: changeDescription("feat: recover checkpoint") }); assert.equal(stopped.kind, "blocked");
    assert.equal(await runtime.operations.reconcileInterrupted(created.receipt.workspaceId), "completed"); const tracked = await runtime.workspaces.get(created.receipt.workspaceId); assert.equal(tracked?.phase, "active"); if (tracked?.phase === "active") { assert.equal(tracked.writer.phase, "available"); assert.notEqual(tracked.identity.expectedHeadChangeId, tracked.identity.rootChangeId); }
  } finally { await fixture.dispose(); }
});

test("interrupted rebase reconstructs preserved range identity", async () => {
  const fixture = await RealJjFixture.create("pi-tai-isolated-rebase-recovery-"); let interrupt = false;
  try {
    await fixture.seed({ changes: [{ description: "base", files: { "base.txt": "base\n" } }] });
    const runtime = new IsolatedJjRuntime({ stateRoot: join(fixture.root, "state"), executor: fixture.executor, failpoint: (operation, boundary) => { if (interrupt && operation === "rebase_workspace" && boundary === "after_mutation") { interrupt = false; throw new Error("injected rebase interruption"); } } });
    const source = await runtime.shared.openSource(fixture.repoPath); const created = await runtime.operations.createWorkspace(source, { name: workspaceName("rebase-recover"), ownerContextId: "child-r", rootSessionId: "root-1" }); assert.equal(created.kind, "completed"); if (created.kind !== "completed") return;
    await writeFile(join(created.receipt.path, "feature.txt"), "feature\n"); const checkpoint = await runtime.operations.checkpointWorkspace(created.receipt.lease, { description: changeDescription("feat: recover rebase") }); assert.equal(checkpoint.kind, "completed"); if (checkpoint.kind !== "completed") return; await runtime.operations.releaseWriter(checkpoint.receipt.lease);
    interrupt = true; const stopped = await runtime.operations.rebaseWorkspace(workspaceRebaseLease(created.receipt.workspaceId, workspaceWriteLeaseId("rebase-recovery")), { kind: "source_parent" }); assert.equal(stopped.kind, "blocked"); assert.equal(await runtime.operations.reconcileInterrupted(created.receipt.workspaceId), "completed");
    const tracked = await runtime.workspaces.get(created.receipt.workspaceId); assert.equal(tracked?.phase, "active"); if (tracked?.phase === "active") assert.equal(tracked.writer.phase, "available");
  } finally { await fixture.dispose(); }
});

test("interrupted normalization resumes from exact completed steps", async () => {
  const fixture = await RealJjFixture.create("pi-tai-isolated-normalize-recovery-"); let interrupt = false;
  try {
    await fixture.seed({ changes: [{ description: "base", files: { "base.txt": "base\n" } }] }); const runtime = new IsolatedJjRuntime({ stateRoot: join(fixture.root, "state"), executor: fixture.executor, failpoint: (operation, boundary) => { if (interrupt && operation === "normalize_change_range" && boundary === "after_mutation") { interrupt = false; throw new Error("injected normalize interruption"); } } }); const source = await runtime.shared.openSource(fixture.repoPath); const created = await runtime.operations.createWorkspace(source, { name: workspaceName("normalize-recover"), ownerContextId: "child-n", rootSessionId: "root-1" }); assert.equal(created.kind, "completed"); if (created.kind !== "completed") return;
    await writeFile(join(created.receipt.path, "feature.txt"), "feature\n"); const checkpoint = await runtime.operations.checkpointWorkspace(created.receipt.lease, { description: changeDescription("feat: initial name") }); assert.equal(checkpoint.kind, "completed"); if (checkpoint.kind !== "completed") return; await runtime.operations.releaseWriter(checkpoint.receipt.lease); interrupt = true;
    const stopped = await runtime.operations.normalizeChangeRange(created.receipt.workspaceId, [{ changeId: created.receipt.rootChangeId, description: changeDescription("feat: normalized name") }]); assert.equal(stopped.kind, "blocked"); assert.equal(await runtime.operations.reconcileInterrupted(created.receipt.workspaceId), "completed");
  } finally { await fixture.dispose(); }
});

test("unreceipted workspace head drift stops checkpoint recovery", async () => {
  const fixture = await RealJjFixture.create("pi-tai-isolated-drift-");
  try {
    await fixture.seed({ changes: [{ description: "base", files: { "base.txt": "base\n" } }] }); const runtime = new IsolatedJjRuntime({ stateRoot: join(fixture.root, "state"), executor: fixture.executor }); const source = await runtime.shared.openSource(fixture.repoPath); const created = await runtime.operations.createWorkspace(source, { name: workspaceName("drift"), ownerContextId: "child-d", rootSessionId: "root-1" }); assert.equal(created.kind, "completed"); if (created.kind !== "completed") return;
    await fixture.run(created.receipt.path, ["new"], "write"); const stopped = await runtime.operations.checkpointWorkspace(created.receipt.lease, { description: changeDescription("feat: should stop") }); assert.equal(stopped.kind, "blocked"); assert.equal(await runtime.operations.reconcileInterrupted(created.receipt.workspaceId), "attention_required"); const tracked = await runtime.workspaces.get(created.receipt.workspaceId); assert.equal(tracked?.phase, "active"); if (tracked?.phase === "active") assert.equal(tracked.writer.phase, "interrupted");
  } finally { await fixture.dispose(); }
});

test("workspace rebase reports conflicts while preserving tracked custody", async () => {
  const fixture = await RealJjFixture.create("pi-tai-isolated-conflict-");
  try {
    await fixture.seed({ changes: [{ description: "base", files: { "shared.txt": "base\n" } }] }); const runtime = new IsolatedJjRuntime({ stateRoot: join(fixture.root, "state"), executor: fixture.executor }); const source = await runtime.shared.openSource(fixture.repoPath); const created = await runtime.operations.createWorkspace(source, { name: workspaceName("conflict"), ownerContextId: "child-c", rootSessionId: "root-1" }); assert.equal(created.kind, "completed"); if (created.kind !== "completed") return;
    await writeFile(join(created.receipt.path, "shared.txt"), "workspace\n"); const checkpoint = await runtime.operations.checkpointWorkspace(created.receipt.lease, { description: changeDescription("feat: workspace side") }); assert.equal(checkpoint.kind, "completed"); if (checkpoint.kind !== "completed") return; await runtime.operations.releaseWriter(checkpoint.receipt.lease);
    await writeFile(join(fixture.repoPath, "shared.txt"), "source\n"); await fixture.run(fixture.repoPath, ["describe", "--message", "feat: source side"], "write"); await fixture.run(fixture.repoPath, ["new"], "write");
    const rebased = await runtime.operations.rebaseWorkspace(workspaceRebaseLease(created.receipt.workspaceId, workspaceWriteLeaseId("rebase-conflict")), { kind: "source_parent" }); if (rebased.kind !== "completed") throw new Error(JSON.stringify(await runtime.workspaces.get(created.receipt.workspaceId))); assert.equal(rebased.receipt.disposition, "conflicted"); const tracked = await runtime.workspaces.get(created.receipt.workspaceId); assert.equal(tracked?.phase, "active");
  } finally { await fixture.dispose(); }
});

test("foreign descendants stop report freeze without discarding custody", async () => {
  const fixture = await RealJjFixture.create("pi-tai-isolated-foreign-");
  try {
    await fixture.seed({ changes: [{ description: "base", files: { "base.txt": "base\n" } }] }); const runtime = new IsolatedJjRuntime({ stateRoot: join(fixture.root, "state"), executor: fixture.executor }); const source = await runtime.shared.openSource(fixture.repoPath); const created = await runtime.operations.createWorkspace(source, { name: workspaceName("foreign"), ownerContextId: "child-f", rootSessionId: "root-1" }); assert.equal(created.kind, "completed"); if (created.kind !== "completed") return;
    await runtime.operations.releaseWriter(created.receipt.lease); await fixture.run(created.receipt.path, ["new", `exactly(change_id(${created.receipt.rootChangeId}), 1)`, "--no-edit"], "write"); const report = await runtime.operations.prepareWorkspaceReport(created.receipt.workspaceId); assert.equal(report.kind, "blocked"); if (report.kind === "blocked") assert.equal(report.blocker.kind, "foreign_work"); assert.equal((await runtime.workspaces.get(created.receipt.workspaceId))?.phase, "active");
  } finally { await fixture.dispose(); }
});

test("entirely empty tracked range freezes without synthetic history", async () => {
  const fixture = await RealJjFixture.create("pi-tai-isolated-empty-");
  try {
    await fixture.seed({ changes: [{ description: "base", files: { "base.txt": "base\n" } }] });
    const runtime = new IsolatedJjRuntime({ stateRoot: join(fixture.root, "state"), executor: fixture.executor });
    const source = await runtime.shared.openSource(fixture.repoPath);
    const created = await runtime.operations.createWorkspace(source, { name: workspaceName("empty-work"), ownerContextId: "child-2", rootSessionId: "root-1" }); assert.equal(created.kind, "completed"); if (created.kind !== "completed") return;
    await runtime.operations.releaseWriter(created.receipt.lease);
    const report = await runtime.operations.prepareWorkspaceReport(created.receipt.workspaceId); assert.equal(report.kind, "completed"); if (report.kind === "completed") assert.equal(report.receipt.range, "empty");
    const tracked = await runtime.workspaces.get(created.receipt.workspaceId); assert.equal(tracked?.phase, "reported"); if (tracked?.phase === "reported") { assert.equal(tracked.report.range, "empty"); assert.equal(tracked.report.evidence, "inline"); if (tracked.report.evidence === "inline") assert.deepEqual(tracked.report.orderedChangeIds, []); }
  } finally { await fixture.dispose(); }
});
