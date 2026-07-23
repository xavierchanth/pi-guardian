import assert from "node:assert/strict";
import test from "node:test";
import { JjWorkspaceService } from "../../packages/pi-tai/src/workspaces/jj-service.ts";
import { RealJjFixture } from "../support/real-jj-fixture.ts";

test("Real-JJ fixture independently proves workspace relocation above exact source parent", async () => {
  const fixture = await RealJjFixture.create("pi-tai-jj-fixture-");
  try {
    const seeded = await fixture.seed({
      changes: [{ description: "base", files: { "base.txt": "base\n" } }],
      workingCopyFiles: { "source.txt": "uncheckpointed source work\n" },
    });
    const before = await fixture.snapshot();
    const service = new JjWorkspaceService(fixture.executor);
    const created = await service.createRelocationWorkspace(fixture.repoPath, "focused");
    fixture.trackWorkspace(created.childWorkspace, created.childWorkspacePath);
    const after = await fixture.snapshot();

    const sourceBefore = before.workingCopies.find((item) => item.workspace === "default");
    const sourceAfter = after.workingCopies.find((item) => item.workspace === "default");
    assert.ok(sourceBefore && sourceAfter);
    assert.equal(sourceBefore.changeId, seeded.workingCopyChangeId);
    assert.equal(sourceAfter.changeId, seeded.workingCopyChangeId);
    assert.equal(sourceAfter.contentHash, sourceBefore.contentHash);

    const allocated = after.workspaces.find((item) => item.name === "focused");
    assert.equal(allocated?.targetChangeId, created.childRootChangeId);
    const root = after.changes.find((item) => item.changeId === created.childRootChangeId);
    assert.deepEqual(root?.parentChangeIds, [created.baseChangeId]);
    assert.equal(root?.empty, true);
    assert.notEqual(after.operationId, before.operationId);
  } catch (error) {
    const retained = await fixture.retainOnFailure("workspace relocation");
    if (error instanceof Error) error.message += `\nRetained fixture: ${retained.path}`;
    throw error;
  } finally {
    await fixture.dispose();
  }
});
