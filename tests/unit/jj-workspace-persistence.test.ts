import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileIsolatedWorkspaceStore, validateIsolatedWorkspace, type PersistedIsolatedWorkspaceV1 } from "../../packages/pi-tai/src/jj/workspace-persistence.ts";

const A = "a".repeat(32); const B = "b".repeat(32); const C = "c".repeat(32); const D = "d".repeat(32); const HASH = "0".repeat(64);
function active(root: string): PersistedIsolatedWorkspaceV1 {
  return { version: 1, phase: "active", identity: { workspaceId: "workspace-1", rootSessionId: "root-1", sourceId: "source-1", sourceWipChangeId: A, baseChangeId: B, name: "planned", path: join(root, "planned"), rootChangeId: C, expectedHeadChangeId: C }, writer: { phase: "leased", ownerContextId: "child-1", leaseId: "lease-1", headChangeId: C, generation: 1, acquiredAt: "2026-01-01T00:00:00Z" }, targets: [], claims: [], operations: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
}

test("isolated workspace store round trips and serializes updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-workspace-state-"));
  try {
    const store = new FileIsolatedWorkspaceStore(root); await store.create(active(root));
    await Promise.all(Array.from({ length: 10 }, () => store.update("workspace-1", (record) => record.phase === "active" ? { ...record, writer: { ...record.writer, generation: record.writer.generation + 1 } } : record)));
    const value = await store.get("workspace-1"); assert.equal(value?.phase, "active"); if (value?.phase === "active") assert.equal(value.writer.generation, 11);
    const interrupted = await store.interruptLiveWriters("workspace-1", "restart", "2026-01-02T00:00:00Z"); assert.equal(interrupted.phase, "active"); if (interrupted.phase === "active") { assert.equal(interrupted.writer.phase, "interrupted"); assert.equal(interrupted.writer.expectedHeadChangeId, C); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy active workspace records migrate empty file targets and claims", () => {
  const value = active("/tmp/repo") as any; delete value.targets; delete value.claims;
  const migrated = validateIsolatedWorkspace(value); assert.equal(migrated.phase, "active"); if (migrated.phase === "active") { assert.deepEqual(migrated.targets, []); assert.deepEqual(migrated.claims, []); }
});

test("isolated workspace validation rejects cross-phase and identity-invalid state", () => {
  const value = active("/tmp/repo");
  assert.throws(() => validateIsolatedWorkspace({ ...value, report: { range: "empty", proofHash: HASH, evidence: "inline", orderedChangeIds: [C] } }), /another phase/);
  assert.throws(() => validateIsolatedWorkspace({ ...value, writer: { ...(value as any).writer, headChangeId: A } }), /expected head/);
  assert.throws(() => validateIsolatedWorkspace({ ...value, operations: [{ operationId: "op-1", kind: "workspace_checkpoint", idempotencyKey: "x", startedAt: "now", beforeJjOperationId: "jj", intent: {}, outcome: { phase: "completed" } }] }), /requires receipt/);
});

test("reported workspace cannot contain writer authority", () => {
  const original = active("/tmp/repo"); if (original.phase !== "active") throw new Error();
  const value = { ...original, identity: { ...original.identity, expectedHeadChangeId: D }, writer: { ...original.writer, headChangeId: D } } as typeof original;
  const reported = { ...value, phase: "reported", reportOperationId: "op-1", report: { range: "nonempty", contentTipChangeId: C, normalizedPatchHash: HASH, evidence: "inline", orderedChangeIds: [C], conflictPaths: [] } };
  delete (reported as any).writer;
  assert.doesNotThrow(() => validateIsolatedWorkspace(reported));
  assert.throws(() => validateIsolatedWorkspace({ ...reported, writer: value.writer }), /another phase/);
});
