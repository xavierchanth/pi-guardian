import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { changeDescription, workspaceName } from "../../packages/pi-tai/src/jj/domain.ts";
import { IsolatedJjRuntime } from "../../packages/pi-tai/src/jj/isolated-runtime.ts";
import { RealJjFixture } from "../support/real-jj-fixture.ts";

test("one isolated workspace checkpoints disjoint active claims into assigned targets", async () => {
  const fixture = await RealJjFixture.create("pi-tai-workspace-file-sets-");
  try {
    await fixture.seed({ changes: [{ description: "base", files: { "base.txt": "base\n" } }] });
    const runtime = new IsolatedJjRuntime({ stateRoot: join(fixture.root, "state"), executor: fixture.executor });
    const source = await runtime.shared.openSource(fixture.repoPath);
    const created = await runtime.operations.createWorkspace(source, { name: workspaceName("file-claims"), ownerContextId: "implementation-lead-1", rootSessionId: "root-1" });
    assert.equal(created.kind, "completed"); if (created.kind !== "completed") return;
    await runtime.operations.releaseWriter(created.receipt.lease);
    const firstTarget = await runtime.workspaceFileSets.assignTarget(created.receipt.workspaceId, { ownerContextId: "worker-1", description: changeDescription("feat: add first file") });
    const secondTarget = await runtime.workspaceFileSets.assignTarget(created.receipt.workspaceId, { ownerContextId: "worker-2", description: changeDescription("feat: add second file") });
    assert.notEqual(firstTarget, secondTarget);
    const first = await runtime.workspaceFileSets.acquire(created.receipt.workspaceId, { ownerContextId: "worker-1", paths: ["first.txt"] });
    const second = await runtime.workspaceFileSets.acquire(created.receipt.workspaceId, { ownerContextId: "worker-2", paths: ["second.txt"] });
    await writeFile(join(created.receipt.path, "first.txt"), "first\n"); await runtime.workspaceFileSets.recordOwnedMutation(created.receipt.workspaceId, "worker-1", "first.txt");
    await writeFile(join(created.receipt.path, "second.txt"), "second\n"); await runtime.workspaceFileSets.recordOwnedMutation(created.receipt.workspaceId, "worker-2", "second.txt");
    const firstReceipt = await runtime.workspaceFileCheckpointer.checkpoint(created.receipt.workspaceId, first); assert.equal(firstReceipt.kind, "completed");
    const secondReceipt = await runtime.workspaceFileCheckpointer.checkpoint(created.receipt.workspaceId, second); assert.equal(secondReceipt.kind, "completed");
    if (firstReceipt.kind === "completed" && secondReceipt.kind === "completed") {
      assert.deepEqual(firstReceipt.receipt.changedPaths, ["first.txt"]);
      assert.deepEqual(secondReceipt.receipt.changedPaths, ["second.txt"]);
      assert.equal(firstReceipt.receipt.checkpointedChangeId, firstTarget);
      assert.equal(secondReceipt.receipt.checkpointedChangeId, secondTarget);
    }
    const stored = await runtime.workspaces.get(created.receipt.workspaceId); assert.equal(stored?.phase, "active");
    if (stored?.phase === "active") assert.equal(stored.claims.filter((claim) => claim.phase !== "released").length, 0);
  } finally { await fixture.dispose(); }
});
