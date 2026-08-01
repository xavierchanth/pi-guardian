import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteWorkspaceCustody } from "../../packages/pi-tai/src/core/isolation/sqlite-custody.ts";
import type {
  RepositoryEvidence,
  WorkspaceCustodyPort,
} from "../../packages/pi-tai/src/core/isolation/custody-port.ts";
import { migrateWorkspaceRegistry } from "../../packages/pi-tai/src/core/storage/custody-migration.ts";
import { resolveStoragePaths } from "../../packages/pi-tai/src/core/storage/paths.ts";
import { openDurableDatabase } from "../../packages/pi-tai/src/core/storage/sqlite.ts";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pitai-s1-"));
  const agentDir = join(home, ".pi", "agent");
  const source = join(agentDir, "pi-tai", "agents", "workspaces.json");
  mkdirSync(join(agentDir, "pi-tai", "agents"), { recursive: true });
  const paths = resolveStoragePaths({}, home);
  const db = openDurableDatabase({ paths });
  return { home, agentDir, source, paths, db };
}
const valid = [
  {
    version: 2,
    id: "w1",
    name: "same",
    path: "/tmp/w",
    repoRoot: "/tmp/repo",
    rootSessionId: "s1",
    rootChangeId: "kkkk",
    baseChangeIds: ["llll"],
    phase: "active",
  },
];

test("B1-B5 malformed and structurally unsafe migration input is quarantined without source retirement", () => {
  for (const value of [
    "{",
    JSON.stringify([{ ...valid[0], rootChangeId: undefined }]),
    JSON.stringify([{ ...valid[0], baseChangeIds: [] }]),
    JSON.stringify([{ ...valid[0], rootChangeId: "bad!" }]),
    JSON.stringify([{ ...valid[0], repoRoot: "relative" }]),
  ]) {
    const f = fixture();
    writeFileSync(f.source, value);
    const before = readFileSync(f.source);
    assert.equal(migrateWorkspaceRegistry(f.db, f.agentDir, f.paths), undefined);
    assert.deepEqual(readFileSync(f.source), before);
    assert.ok(existsSync(f.source));
    assert.equal((f.db.prepare("SELECT count(*) n FROM quarantine").get() as { n: number }).n, 1);
    f.db.close();
  }
});

test("B6-B8 migration receipt/copy are idempotent and source is retired only after commit", () => {
  const f = fixture();
  writeFileSync(f.source, JSON.stringify(valid));
  const receipt = migrateWorkspaceRegistry(f.db, f.agentDir, f.paths);
  assert.ok(receipt && existsSync(receipt));
  assert.equal(existsSync(f.source), false);
  assert.equal(migrateWorkspaceRegistry(f.db, f.agentDir, f.paths), undefined);
  assert.equal(
    (f.db.prepare("SELECT count(*) n FROM workspace WHERE id='w1'").get() as { n: number }).n,
    1,
  );
  f.db.close();
});

test("B9-B10 repository fingerprint is stable by evidence, not workspace name or checkout path", async () => {
  const f = fixture();
  const port: WorkspaceCustodyPort = new SqliteWorkspaceCustody(f.db);
  const evidence: RepositoryEvidence = {
    roots: ["kkkk"],
    rootsTruncated: false,
    storeKey: "store-a",
    canonicalRoot: "/one",
    now: "2025-01-01T00:00:00.000Z",
  };
  const one = await port.establishRepository(evidence);
  const alias = await port.establishRepository({ ...evidence, canonicalRoot: "/alias" });
  const other = await port.establishRepository({
    ...evidence,
    storeKey: "store-b",
    canonicalRoot: "/two",
  });
  assert.equal(one.repoId, alias.repoId);
  assert.notEqual(one.repoId, other.repoId);
  f.db.close();
});

test("B11-B12 invalid repository evidence is rejected without invented identity", async () => {
  const f = fixture();
  const port = new SqliteWorkspaceCustody(f.db);
  await assert.rejects(
    port.establishRepository({ roots: [], rootsTruncated: false, canonicalRoot: "/r", now: "x" }),
  );
  await assert.rejects(
    port.establishRepository({
      roots: ["bad"],
      rootsTruncated: false,
      canonicalRoot: "/r",
      now: "x",
    }),
  );
  assert.equal(
    (
      f.db.prepare("SELECT count(*) n FROM repository WHERE identity_proven=1").get() as {
        n: number;
      }
    ).n,
    0,
  );
  f.db.close();
});
