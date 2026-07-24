import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FileSharedSourceStore,
  validateSharedSource,
  type PersistedSharedSourceV1,
} from "../../packages/pi-tai/src/jj/persistence.ts";

const CHANGE_A = "a".repeat(32);
const CHANGE_B = "b".repeat(32);
const DIGEST = "0".repeat(64);

function source(root: string): PersistedSharedSourceV1 {
  return {
    version: 1,
    sourceId: "source-1",
    repositoryRoot: root,
    workspacePath: join(root, "workspace"),
    workspaceName: "default",
    wip: { changeId: CHANGE_A, description: "wip: thinker workspace", ensuredOperationId: "operation-1" },
    targets: [{
      changeId: CHANGE_B,
      wipChangeId: CHANGE_A,
      ownerContextId: "child-1",
      description: "feat: bounded work",
      insertOperationId: "operation-2",
      createdAt: "2026-01-01T00:00:00.000Z",
    }],
    claims: [{
      phase: "active",
      claimId: "claim-1",
      ownerContextId: "child-1",
      rootSessionId: "root-1",
      targetChangeId: CHANGE_B,
      wipChangeId: CHANGE_A,
      paths: ["src/a.ts"],
      queuedAt: "2026-01-01T00:00:00.000Z",
      acquiredAt: "2026-01-01T00:00:01.000Z",
      fingerprints: [{ path: "src/a.ts", digest: DIGEST }],
      mutatedPaths: [],
    }],
    operations: [{
      phase: "started",
      operationId: "operation-3",
      kind: "checkpoint_change",
      idempotencyKey: "checkpoint:claim-1",
      startedAt: "2026-01-01T00:00:02.000Z",
      beforeJjOperationId: "jj-op-1",
    }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:02.000Z",
  };
}

test("shared source store round trips strict versioned state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-jj-state-"));
  try {
    const store = new FileSharedSourceStore(join(root, "state"));
    const record = source(root);
    await store.create(record);
    assert.deepEqual(await store.get(record.sourceId), record);
    assert.deepEqual(await store.list(), [record]);
    const raw = JSON.parse(await readFile(join(root, "state", "source-1.json"), "utf8"));
    assert.equal(raw.version, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared source validation rejects invalid phase combinations and paths", () => {
  const root = "/tmp/repo";
  const invalidFingerprint = structuredClone(source(root)) as any;
  invalidFingerprint.claims[0].fingerprints = [];
  assert.throws(() => validateSharedSource(invalidFingerprint), /one fingerprint per path/);

  const traversal = structuredClone(source(root)) as any;
  traversal.claims[0].paths = ["../outside"];
  assert.throws(() => validateSharedSource(traversal), /Invalid repository-relative path/);

  const duplicate = structuredClone(source(root)) as any;
  duplicate.targets.push(duplicate.targets[0]);
  assert.throws(() => validateSharedSource(duplicate), /Duplicate shared target/);
});

test("shared source updates serialize and restart interrupts every live claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-jj-state-"));
  try {
    const store = new FileSharedSourceStore(join(root, "state"));
    await store.create(source(root));
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.update("source-1", (record) => ({
      ...record,
      workspaceName: `${record.workspaceName}-next`,
      updatedAt: `2026-01-01T00:00:${String(index + 3).padStart(2, "0")}.000Z`,
    }))));
    const updated = await store.get("source-1");
    assert.equal(updated?.workspaceName, `default${"-next".repeat(20)}`);

    const interrupted = await store.interruptLiveClaims("source-1", "process restart", "2026-01-01T00:00:05.000Z");
    assert.deepEqual(interrupted.claims[0], {
      claimId: "claim-1",
      ownerContextId: "child-1",
      rootSessionId: "root-1",
      targetChangeId: CHANGE_B,
      wipChangeId: CHANGE_A,
      paths: ["src/a.ts"],
      queuedAt: "2026-01-01T00:00:00.000Z",
      phase: "interrupted",
      priorPhase: "active",
      reason: "process restart",
      interruptedAt: "2026-01-01T00:00:05.000Z",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
