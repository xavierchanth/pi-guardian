import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_WORKSPACE_ARTIFACT_BYTES, WorkspaceArtifactStore } from "../../packages/pi-tai/src/jj/workspace-artifacts.ts";

test("workspace artifacts are immutable content-addressed bounded evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-artifacts-"));
  try {
    const store = new WorkspaceArtifactStore(root); const first = await store.putJson("workspace-1", "range", { value: "evidence" }); const second = await store.putJson("workspace-1", "range", { value: "evidence" });
    assert.equal(first.digest, second.digest); assert.equal(first.path, second.path); assert.match(await readFile(first.path, "utf8"), /evidence/);
    await assert.rejects(store.putJson("../escape", "range", {}), /Invalid workspace artifact/);
    await assert.rejects(store.putJson("workspace-1", "range", { value: "x".repeat(MAX_WORKSPACE_ARTIFACT_BYTES) }), /exceeds/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
