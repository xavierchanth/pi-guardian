import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
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

test("Real-JJ preserves owned range Change IDs when its root is rebased onto newer trunk", async () => {
  const fixture = await RealJjFixture.create("pi-tai-jj-rebase-");
  try {
    await fixture.seed({ changes: [{ description: "base", files: { "base.txt": "base\n" } }] });
    const service = new JjWorkspaceService(fixture.executor);
    const created = await service.createRelocationWorkspace(fixture.repoPath, "rebased-worker");
    fixture.trackWorkspace(created.childWorkspace, created.childWorkspacePath);

    await writeFile(`${created.childWorkspacePath}/owned.txt`, "owned change\n");
    await fixture.run(created.childWorkspacePath, ["describe", "--message", "feat: owned change"], "write");
    const contentTip = await fixture.currentChangeId(created.childWorkspacePath);
    await fixture.run(created.childWorkspacePath, ["new"], "write");
    const workspaceHead = await fixture.currentChangeId(created.childWorkspacePath);

    await writeFile(`${fixture.repoPath}/trunk.txt`, "new trunk content\n");
    await fixture.run(fixture.repoPath, ["describe", "--message", "feat: newer trunk"], "write");
    const newBase = await fixture.currentChangeId(fixture.repoPath);
    await fixture.run(fixture.repoPath, ["new"], "write");

    const before = await fixture.snapshot();
    await fixture.run(fixture.repoPath, [
      "--ignore-working-copy",
      "rebase",
      "--source", `exactly(change_id(${created.childRootChangeId}), 1)`,
      "--onto", `exactly(change_id(${newBase}), 1)`,
    ], "write");
    await fixture.run(created.childWorkspacePath, ["workspace", "update-stale"], "write");
    const after = await fixture.snapshot();

    assert.equal(await fixture.currentChangeId(created.childWorkspacePath), workspaceHead);
    const root = after.changes.find((change) => change.changeId === created.childRootChangeId);
    assert.deepEqual(root?.parentChangeIds, [newBase]);
    assert.equal(after.changes.some((change) => change.changeId === contentTip), true);
    assert.equal(after.changes.some((change) => change.changeId === workspaceHead), true);
    const beforeOwnedIds = before.changes
      .filter((change) => change.changeId === created.childRootChangeId || change.changeId === workspaceHead)
      .map((change) => change.changeId)
      .sort();
    const afterOwnedIds = after.changes
      .filter((change) => change.changeId === created.childRootChangeId || change.changeId === workspaceHead)
      .map((change) => change.changeId)
      .sort();
    assert.deepEqual(afterOwnedIds, beforeOwnedIds);
  } catch (error) {
    const retained = await fixture.retainOnFailure("workspace base rebase");
    if (error instanceof Error) error.message += `\nRetained fixture: ${retained.path}`;
    throw error;
  } finally {
    await fixture.dispose();
  }
});
