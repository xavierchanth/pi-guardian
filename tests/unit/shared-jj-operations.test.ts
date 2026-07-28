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
  return { store, operations, source };
}

test("Real-JJ inserts shared targets before arbitrary nonempty user @ without rewriting it", async (t) => {
  const fixture = await RealJjFixture.create("pi-tai-insert-shared-");
  try {
    await fixture.run(fixture.repoPath, ["describe", "--message", "user: ongoing work"], "write");
    await mkdir(join(fixture.repoPath, "src"), { recursive: true });
    await writeFile(join(fixture.repoPath, "src", "user.ts"), "export const user = true;\n");
    const before = await fixture.snapshot();
    const beforeHead = before.workingCopies[0]!;
    const beforeWorking = before.changes.find((change) => change.changeId === beforeHead.changeId)!;
    const base = beforeWorking.parentChangeIds[0]!;
    const { store, operations, source } = await runtime(fixture);
    const first = await operations.insertChange(source, { description: changeDescription("feat(shared): add owned value"), owner: childContextId("child-1") });
    assert.equal(first.kind, "completed");
    if (first.kind !== "completed") return;
    assert.equal(first.receipt.baseChangeId, base);
    assert.equal(first.receipt.workingChangeId, beforeHead.changeId);
    const second = await operations.insertChange(source, { description: changeDescription("test(shared): cover owned value"), owner: childContextId("child-2") });
    assert.equal(second.kind, "completed");
    if (second.kind !== "completed") return;
    const after = await fixture.snapshot();
    assert.equal(after.workingCopies[0]?.changeId, beforeHead.changeId);
    assert.equal(after.workingCopies[0]?.contentHash, beforeHead.contentHash);
    assert.equal(after.changes.find((change) => change.changeId === beforeHead.changeId)?.description, "user: ongoing work");
    const working = after.changes.find((change) => change.changeId === beforeHead.changeId)!;
    assert.deepEqual(working.parentChangeIds, [second.receipt.insertedChangeId]);
    assert.deepEqual(after.changes.find((change) => change.changeId === second.receipt.insertedChangeId)?.parentChangeIds, [first.receipt.insertedChangeId]);
    assert.deepEqual(after.changes.find((change) => change.changeId === first.receipt.insertedChangeId)?.parentChangeIds, [base]);
    const targets = (await store.get(source.sourceId))?.targets ?? [];
    assert.deepEqual(targets.map((target) => target.ownerContextId), ["child-1", "child-2"]);
    assert.equal(targets[0]?.baseChangeId, base);
    assert.equal(targets[0]?.workingChangeId, beforeHead.changeId);
  } catch (error) {
    const retained = await fixture.retainOnFailure(t.name);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nRetained fixture: ${retained.path}`);
  } finally { await fixture.dispose(); }
});

test("shared insertion blocks when current @ is a merge", async () => {
  const current = "a".repeat(32); const left = "b".repeat(32); const right = "c".repeat(32);
  let blocked: unknown;
  const kernel = {
    withRepositoryMutation: async (_source: unknown, fn: () => Promise<unknown>) => fn(),
    inspect: async () => ({ current: { changeId: current, commitId: "commit", empty: false, conflicted: false, immutable: false, parentChangeIds: [left, right], description: "user merge" }, jjOperationId: "op-before", source: {} }),
    startOperation: async () => ({ operationId: "jjop-merge", beforeJjOperationId: "op-before" }),
    blockOperation: async (_source: unknown, _operationId: string, blocker: unknown) => { blocked = blocker; },
  } as unknown as JjRepositoryKernel;
  const store = { update: async () => { throw new Error("must not persist a target"); } } as unknown as FileSharedSourceStore;
  const operations = new SharedJjOperations({ kernel, store });
  const source = { kind: "source_workspace", sourceId: "source-merge" } as const;
  const result = await operations.insertChange(source as any, { description: changeDescription("feat: must not choose a parent"), owner: childContextId("child-1") });
  assert.deepEqual(result.kind === "blocked" ? result.blocker.kind : "completed", "decision_required");
  assert.deepEqual((blocked as any)?.kind, "decision_required");
});
