import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { childContextId } from "../../packages/pi-tai/src/concurrency/ids.ts";
import { changeDescription } from "../../packages/pi-tai/src/jj/domain.ts";
import { FileSharedSourceStore } from "../../packages/pi-tai/src/jj/persistence.ts";
import { JjRepositoryKernel } from "../../packages/pi-tai/src/jj/repository.ts";
import { SharedJjOperations } from "../../packages/pi-tai/src/jj/shared-operations.ts";
import { RealJjFixture } from "../support/real-jj-fixture.ts";

async function runtime(fixture: RealJjFixture) {
  const store = new FileSharedSourceStore(join(fixture.root, "pi-tai-state"));
  const kernel = new JjRepositoryKernel({ executor: fixture.executor, store });
  const operations = new SharedJjOperations({ kernel, store });
  const source = await kernel.openSource(fixture.repoPath);
  return { store, kernel, operations, source };
}

test("Real-JJ ensures an empty source WIP without changing its Change ID", async (t) => {
  const fixture = await RealJjFixture.create("pi-tai-ensure-wip-");
  try {
    const before = await fixture.snapshot();
    const { operations, source } = await runtime(fixture);
    const current = await fixture.currentChangeId(fixture.repoPath);
    const result = await operations.ensureWip(source);
    assert.equal(result.kind, "completed");
    if (result.kind !== "completed") return;
    assert.equal(result.receipt.wipChangeId, current);
    assert.equal(result.receipt.disposition, "described_existing");
    assert.equal(result.receipt.privateProtection, "missing");
    const after = await fixture.snapshot();
    assert.equal(after.workingCopies[0]?.changeId, before.workingCopies[0]?.changeId);
    const wip = after.changes.find((change) => change.changeId === current);
    assert.equal(wip?.description, "wip: thinker workspace");
    assert.equal(wip?.empty, true);
  } catch (error) {
    const retained = await fixture.retainOnFailure(t.name);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nRetained fixture: ${retained.path}`);
  } finally {
    await fixture.dispose();
  }
});

test("Real-JJ refuses to relabel unknown nonempty source work", async (t) => {
  const fixture = await RealJjFixture.create("pi-tai-unknown-wip-");
  try {
    await writeFile(join(fixture.repoPath, "unknown.txt"), "user work\n");
    const before = await fixture.snapshot();
    const { operations, source } = await runtime(fixture);
    const result = await operations.ensureWip(source);
    assert.deepEqual(result.kind === "blocked" ? result.blocker.kind : "completed", "decision_required");
    const after = await fixture.snapshot();
    assert.equal(after.workingCopies[0]?.changeId, before.workingCopies[0]?.changeId);
    assert.equal(after.workingCopies[0]?.contentHash, before.workingCopies[0]?.contentHash);
    const current = after.changes.find((change) => change.changeId === after.workingCopies[0]?.changeId);
    assert.equal(current?.description, "");
  } catch (error) {
    const retained = await fixture.retainOnFailure(t.name);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nRetained fixture: ${retained.path}`);
  } finally {
    await fixture.dispose();
  }
});

test("Real-JJ inserts assigned empty targets before WIP while preserving WIP content", async (t) => {
  const fixture = await RealJjFixture.create("pi-tai-insert-shared-");
  try {
    const { store, operations, source } = await runtime(fixture);
    const ensured = await operations.ensureWip(source);
    assert.equal(ensured.kind, "completed");
    await mkdir(join(fixture.repoPath, "src"), { recursive: true });
    await writeFile(join(fixture.repoPath, "src", "owned.ts"), "export const value = 1;\n");
    const before = await fixture.snapshot();
    const beforeHead = before.workingCopies[0]!;
    const first = await operations.insertChange(source, {
      description: changeDescription("feat(shared): add owned value"),
      owner: childContextId("child-1"),
    });
    assert.equal(first.kind, "completed");
    if (first.kind !== "completed") return;
    const second = await operations.insertChange(source, {
      description: changeDescription("test(shared): cover owned value"),
      owner: childContextId("child-2"),
    });
    assert.equal(second.kind, "completed");
    if (second.kind !== "completed") return;
    const after = await fixture.snapshot();
    assert.equal(after.workingCopies[0]?.changeId, beforeHead.changeId);
    assert.equal(after.workingCopies[0]?.contentHash, beforeHead.contentHash);
    const wip = after.changes.find((change) => change.changeId === beforeHead.changeId)!;
    assert.deepEqual(wip.parentChangeIds, [second.receipt.insertedChangeId]);
    const secondTarget = after.changes.find((change) => change.changeId === second.receipt.insertedChangeId)!;
    assert.deepEqual(secondTarget.parentChangeIds, [first.receipt.insertedChangeId]);
    assert.equal(after.changes.find((change) => change.changeId === first.receipt.insertedChangeId)?.empty, true);
    assert.equal(secondTarget.empty, true);
    assert.deepEqual((await store.get(source.sourceId))?.targets.map((target) => target.ownerContextId), ["child-1", "child-2"]);
  } catch (error) {
    const retained = await fixture.retainOnFailure(t.name);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nRetained fixture: ${retained.path}`);
  } finally {
    await fixture.dispose();
  }
});
