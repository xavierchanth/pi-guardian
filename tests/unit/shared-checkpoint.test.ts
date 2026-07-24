import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { SharedFileSetCoordinator } from "../../packages/pi-tai/src/concurrency/file-sets.ts";
import { childContextId } from "../../packages/pi-tai/src/concurrency/ids.ts";
import { changeDescription } from "../../packages/pi-tai/src/jj/domain.ts";
import { FileSharedSourceStore } from "../../packages/pi-tai/src/jj/persistence.ts";
import { JjRepositoryKernel } from "../../packages/pi-tai/src/jj/repository.ts";
import {
  createJjBaselineVerifier,
  DeterministicSharedCheckpointer,
} from "../../packages/pi-tai/src/jj/shared-checkpoint.ts";
import { SharedJjOperations } from "../../packages/pi-tai/src/jj/shared-operations.ts";
import { RealJjFixture } from "../support/real-jj-fixture.ts";

async function runtime(fixture: RealJjFixture) {
  const store = new FileSharedSourceStore(join(fixture.root, "pi-tai-state"));
  const kernel = new JjRepositoryKernel({ executor: fixture.executor, store });
  const operations = new SharedJjOperations({ kernel, store });
  const source = await kernel.openSource(fixture.repoPath);
  const fileSets = new SharedFileSetCoordinator({ store, verifyBaseline: createJjBaselineVerifier(kernel) });
  const checkpointer = new DeterministicSharedCheckpointer({ kernel, store, fileSets });
  return { store, kernel, operations, source, fileSets, checkpointer };
}

async function setupTarget(fixture: RealJjFixture, owner: string, description: string) {
  const r = await runtime(fixture);
  const ensured = await r.operations.ensureWip(r.source);
  assert.equal(ensured.kind, "completed");
  const inserted = await r.operations.insertChange(r.source, {
    description: changeDescription(description),
    owner: childContextId(owner),
  });
  assert.equal(inserted.kind, "completed");
  if (inserted.kind !== "completed") throw new Error("target insertion failed");
  return { ...r, inserted: inserted.receipt };
}

test("Real-JJ checkpoints only locked paths and preserves unrelated WIP", async (t) => {
  const fixture = await RealJjFixture.create("pi-tai-shared-checkpoint-");
  try {
    const r = await setupTarget(fixture, "child-1", "feat(shared): checkpoint owned file");
    const claim = await r.fileSets.acquire(r.source, {
      rootSessionId: "root-1", ownerContextId: "child-1", paths: ["src/owned.ts"],
    });
    await mkdir(join(fixture.repoPath, "src"), { recursive: true });
    await writeFile(join(fixture.repoPath, "src", "owned.ts"), "export const owned = true;\n");
    await r.fileSets.recordOwnedMutation(r.source, "child-1", "src/owned.ts");
    await writeFile(join(fixture.repoPath, "notes.md"), "unrelated thinker WIP\n");
    const wipBefore = await fixture.currentChangeId(fixture.repoPath);
    const result = await r.checkpointer.checkpointChange(claim);
    assert.equal(result.kind, "completed");
    if (result.kind !== "completed") return;
    assert.deepEqual(result.receipt.changedPaths, ["src/owned.ts"]);
    assert.equal(result.receipt.wipChangeId, wipBefore);
    const after = await fixture.snapshot();
    assert.equal(after.workingCopies[0]?.changeId, wipBefore);
    const target = after.changes.find((change) => change.changeId === r.inserted.insertedChangeId)!;
    const wip = after.changes.find((change) => change.changeId === wipBefore)!;
    assert.deepEqual(target.changedPaths, ["src/owned.ts"]);
    assert.deepEqual(wip.changedPaths, ["notes.md"]);
    assert.equal((await r.store.get(r.source.sourceId))?.claims[0]?.phase, "released");
  } catch (error) {
    const retained = await fixture.retainOnFailure(t.name);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nRetained fixture: ${retained.path}`);
  } finally {
    await fixture.dispose();
  }
});

test("Real-JJ rejects a claim over pre-existing unowned WIP paths", async (t) => {
  const fixture = await RealJjFixture.create("pi-tai-shared-baseline-");
  try {
    const r = await setupTarget(fixture, "child-1", "feat(shared): unsafe target");
    await writeFile(join(fixture.repoPath, "existing.txt"), "thinker work\n");
    await assert.rejects(() => r.fileSets.acquire(r.source, {
      rootSessionId: "root-1", ownerContextId: "child-1", paths: ["existing.txt"],
    }), /pre-existing unowned WIP changes/);
    assert.equal((await r.store.get(r.source.sourceId))?.claims[0]?.phase, "breached");
  } catch (error) {
    const retained = await fixture.retainOnFailure(t.name);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nRetained fixture: ${retained.path}`);
  } finally {
    await fixture.dispose();
  }
});

test("Real-JJ serializes two workers into deterministic edit-checkpoint history", async (t) => {
  const fixture = await RealJjFixture.create("pi-tai-shared-contention-");
  try {
    const r = await runtime(fixture);
    assert.equal((await r.operations.ensureWip(r.source)).kind, "completed");
    const firstTarget = await r.operations.insertChange(r.source, {
      description: changeDescription("feat(shared): first worker"), owner: childContextId("child-1"),
    });
    const secondTarget = await r.operations.insertChange(r.source, {
      description: changeDescription("feat(shared): second worker"), owner: childContextId("child-2"),
    });
    assert.equal(firstTarget.kind, "completed");
    assert.equal(secondTarget.kind, "completed");
    if (firstTarget.kind !== "completed" || secondTarget.kind !== "completed") return;
    const first = await r.fileSets.acquire(r.source, {
      rootSessionId: "root-1", ownerContextId: "child-1", paths: ["shared.txt"],
    });
    const secondPromise = r.fileSets.acquire(r.source, {
      rootSessionId: "root-1", ownerContextId: "child-2", paths: ["shared.txt"],
    });
    await writeFile(join(fixture.repoPath, "shared.txt"), "first\n");
    await r.fileSets.recordOwnedMutation(r.source, "child-1", "shared.txt");
    assert.equal((await r.checkpointer.checkpointChange(first)).kind, "completed");
    const second = await secondPromise;
    await writeFile(join(fixture.repoPath, "shared.txt"), "first\nsecond\n");
    await r.fileSets.recordOwnedMutation(r.source, "child-2", "shared.txt");
    assert.equal((await r.checkpointer.checkpointChange(second)).kind, "completed");
    const after = await fixture.snapshot();
    const firstChange = after.changes.find((change) => change.changeId === firstTarget.receipt.insertedChangeId)!;
    const secondChange = after.changes.find((change) => change.changeId === secondTarget.receipt.insertedChangeId)!;
    assert.deepEqual(secondChange.parentChangeIds, [firstChange.changeId]);
    assert.deepEqual(firstChange.changedPaths, ["shared.txt"]);
    assert.deepEqual(secondChange.changedPaths, ["shared.txt"]);
    assert.equal(after.changes.find((change) => change.changeId === after.workingCopies[0]?.changeId)?.empty, true);
  } catch (error) {
    const retained = await fixture.retainOnFailure(t.name);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nRetained fixture: ${retained.path}`);
  } finally {
    await fixture.dispose();
  }
});
