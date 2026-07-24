import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalizeFileSet,
  setsOverlap,
  SharedFileSetCoordinator,
} from "../../packages/pi-tai/src/concurrency/file-sets.ts";
import { sourceWorkspaceHandle, sourceWorkspaceId } from "../../packages/pi-tai/src/jj/domain.ts";
import { FileSharedSourceStore, type PersistedSharedSourceV1 } from "../../packages/pi-tai/src/jj/persistence.ts";

const WIP = "a".repeat(32);
const TARGETS = ["b", "c", "d"].map((letter) => letter.repeat(32));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-file-sets-"));
  const workspace = join(root, "repo");
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, "docs"), { recursive: true });
  await writeFile(join(workspace, "src", "a.ts"), "one\n");
  await writeFile(join(workspace, "docs", "guide.md"), "guide\n");
  const store = new FileSharedSourceStore(join(root, "state"));
  const record: PersistedSharedSourceV1 = {
    version: 1,
    sourceId: "source-1",
    repositoryRoot: join(workspace, ".jj", "repo"),
    workspacePath: workspace,
    workspaceName: "default",
    wip: { changeId: WIP, description: "wip: thinker workspace", ensuredOperationId: "operation-1" },
    targets: TARGETS.map((changeId, index) => ({
      changeId,
      wipChangeId: WIP,
      ownerContextId: `child-${index + 1}`,
      description: `feat: child ${index + 1}`,
      insertOperationId: `operation-${index + 2}`,
      createdAt: "2026-01-01T00:00:00.000Z",
    })),
    claims: [],
    operations: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await store.create(record);
  const source = sourceWorkspaceHandle(sourceWorkspaceId("source-1"));
  const coordinator = new SharedFileSetCoordinator({ store, now: () => "2026-01-01T00:00:01.000Z" });
  return { root, workspace, store, source, coordinator };
}

async function pending<T>(promise: Promise<T>): Promise<boolean> {
  return Promise.race([
    promise.then(() => false, () => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 10)),
  ]);
}

test("file-set coordinator grants complete disjoint sets and preserves overlap FIFO", async () => {
  const f = await fixture();
  try {
    const first = await f.coordinator.acquire(f.source, {
      rootSessionId: "root-1", ownerContextId: "child-1", paths: ["src"],
    });
    const secondPromise = f.coordinator.acquire(f.source, {
      rootSessionId: "root-1", ownerContextId: "child-2", paths: ["src/a.ts"],
    });
    const disjoint = await f.coordinator.acquire(f.source, {
      rootSessionId: "root-1", ownerContextId: "child-3", paths: ["docs/guide.md"],
    });
    assert.equal(await pending(secondPromise), true);
    await f.coordinator.releaseUnused(first);
    const second = await secondPromise;
    assert.equal((await f.coordinator.requireActive(second)).record.paths[0], "src/a.ts");
    await f.coordinator.releaseUnused(second);
    await f.coordinator.releaseUnused(disjoint);
    assert.deepEqual((await f.store.get("source-1"))?.claims.map((claim) => claim.phase), ["released", "released", "released"]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("file-set acquisition is atomic and cancellable while queued", async () => {
  const f = await fixture();
  try {
    const first = await f.coordinator.acquire(f.source, {
      rootSessionId: "root-1", ownerContextId: "child-1", paths: ["src/a.ts"],
    });
    const controller = new AbortController();
    const blocked = f.coordinator.acquire(f.source, {
      rootSessionId: "root-1", ownerContextId: "child-2", paths: ["docs", "src/a.ts"], signal: controller.signal,
    });
    assert.equal(await pending(blocked), true);
    const disjointPromise = f.coordinator.acquire(f.source, {
      rootSessionId: "root-1", ownerContextId: "child-3", paths: ["docs"],
    });
    assert.equal(await pending(disjointPromise), true);
    controller.abort();
    await assert.rejects(blocked, { name: "AbortError" });
    const disjoint = await disjointPromise;
    await f.coordinator.releaseUnused(first);
    await f.coordinator.releaseUnused(disjoint);
    const claims = (await f.store.get("source-1"))?.claims;
    assert.equal(claims?.find((claim) => claim.ownerContextId === "child-2")?.phase, "interrupted");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("owned fingerprints allow guarded edits but reject release and detect bypass", async () => {
  const f = await fixture();
  try {
    const claim = await f.coordinator.acquire(f.source, {
      rootSessionId: "root-1", ownerContextId: "child-1", paths: ["src/a.ts"],
    });
    assert.equal(await f.coordinator.authorizePath(f.source, "child-1", "src/a.ts"), "src/a.ts");
    await assert.rejects(() => f.coordinator.authorizePath(f.source, "child-1", "docs/guide.md"), /outside active claim/);
    await writeFile(join(f.workspace, "src", "a.ts"), "owned\n");
    await f.coordinator.recordOwnedMutation(f.source, "child-1", "src/a.ts");
    await assert.rejects(() => f.coordinator.releaseUnused(claim), /without checkpointing/);
    const checkpointing = await f.coordinator.beginCheckpoint(claim, "operation-9");
    assert.equal(checkpointing.record.phase, "checkpointing");
    await f.coordinator.releaseAfterCheckpoint(claim, "operation-9");

    const bypassed = await f.coordinator.acquire(f.source, {
      rootSessionId: "root-1", ownerContextId: "child-1", paths: ["src/a.ts"],
    });
    await writeFile(join(f.workspace, "src", "a.ts"), "external\n");
    await assert.rejects(() => f.coordinator.verifyOwnedState(bypassed), /breached/);
    assert.equal((await f.store.get("source-1"))?.claims.at(-1)?.phase, "breached");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("canonical file sets collapse aliases, reject escapes, and model ancestor overlap", async () => {
  const f = await fixture();
  try {
    await symlink(join(f.workspace, "src"), join(f.workspace, "alias"));
    assert.deepEqual(await canonicalizeFileSet(f.workspace, ["src/a.ts", "alias/a.ts"]), ["src/a.ts"]);
    assert.deepEqual(await canonicalizeFileSet(f.workspace, ["src", "src/new.ts"]), ["src"]);
    await assert.rejects(() => canonicalizeFileSet(f.workspace, ["../outside"]), /Invalid repository-relative path/);
    await symlink(f.root, join(f.workspace, "outside"));
    await assert.rejects(() => canonicalizeFileSet(f.workspace, ["outside/file"]), /outside the source workspace/);
    assert.equal(setsOverlap(["src"], ["src/a.ts"]), true);
    assert.equal(setsOverlap(["src-a"], ["src/a.ts"]), false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
