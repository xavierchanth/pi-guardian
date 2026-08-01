import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  RepositoryEvidence,
  WorkspaceCustodyPort,
} from "../../packages/pi-tai/src/core/isolation/custody-port.ts";
import { SqliteWorkspaceCustody } from "../../packages/pi-tai/src/core/isolation/sqlite-custody.ts";
import { migrateWorkspaceRegistry } from "../../packages/pi-tai/src/core/storage/custody-migration.ts";
import {
  processState,
  withOperationLease,
} from "../../packages/pi-tai/src/core/storage/operation-lease.ts";
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
test("K5b process identity probes conservatively and free lease permits unprovable self", async () => {
  assert.notEqual(processState(process.pid).state, "dead");
  const { db } = fixture();
  let ran = false;
  await withOperationLease(
    db,
    {
      scope: "free",
      owner: "me",
      pidStart: "unprovable",
      processState: () => ({ state: "unknown" }),
    },
    () => {
      ran = true;
    },
  );
  assert.equal(ran, true);
  db.close();
});

test("K5b expired holders are stolen only when dead or PID-reused", async () => {
  for (const [state, succeeds] of [
    [{ state: "dead" } as const, true],
    [{ state: "live", start: "other" } as const, true],
    [{ state: "live", start: "held" } as const, false],
    [{ state: "unknown" } as const, false],
  ] as const) {
    const { db } = fixture();
    db.prepare("INSERT INTO operation_lease VALUES(?,?,?,?,?,?,?)").run(
      "s",
      "old",
      "t",
      42,
      "held",
      0,
      0,
    );
    const attempt = withOperationLease(
      db,
      { scope: "s", owner: "new", pidStart: "new", waitMs: 0, processState: () => state },
      () => undefined,
    );
    if (succeeds) await attempt;
    else await assert.rejects(attempt, /Timed out/);
    db.close();
  }
});

test("K5b token-checked release preserves a successor", async () => {
  const { db } = fixture();
  await withOperationLease(db, { scope: "s", owner: "old", pidStart: "a" }, () => {
    db.prepare(
      "UPDATE operation_lease SET owner='next',token='next',pid_start='b' WHERE scope='s'",
    ).run();
  });
  assert.equal(
    (db.prepare("SELECT owner FROM operation_lease WHERE scope='s'").get() as any).owner,
    "next",
  );
  db.close();
});

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
  // Free acquisition must work even when host process identity is unavailable.
  const receipt = migrateWorkspaceRegistry(f.db, f.agentDir, f.paths, new Date(), () => ({
    state: "unknown",
  }));
  assert.ok(receipt && existsSync(receipt));
  assert.equal(existsSync(f.source), false);
  assert.equal(migrateWorkspaceRegistry(f.db, f.agentDir, f.paths), undefined);
  assert.equal(
    (f.db.prepare("SELECT count(*) n FROM workspace WHERE id='w1'").get() as { n: number }).n,
    1,
  );
  f.db.close();
});

test("B6-B8 simultaneous processes serialize one atomic retirement/receipt with no duplicate or lost rows, then rerun idempotently", async () => {
  const f = fixture();
  writeFileSync(
    f.source,
    JSON.stringify([...valid, { ...valid[0], id: "w2", name: "other", rootChangeId: "mmmm" }]),
  );
  f.db.close();
  const barrier = join(f.home, "start");
  const childPath = join(process.cwd(), "tests/fixtures/custody-migration-child.mjs");
  const ready = [join(f.home, "ready-0"), join(f.home, "ready-1")];
  const children = ready.map((readyPath) =>
    spawn(process.execPath, [childPath, f.home, f.agentDir, barrier, readyPath], {
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const completed = children.map(
    (child) =>
      new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk) => {
          out += chunk;
        });
        child.stderr.on("data", (chunk) => {
          err += chunk;
        });
        child.on("close", (code) => resolve({ code, out, err }));
      }),
  );
  const readinessDeadline = Date.now() + 30_000;
  while (!ready.every(existsSync)) {
    if (Date.now() >= readinessDeadline)
      throw new Error("migration children failed to become ready");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  writeFileSync(barrier, "go");
  const results = await Promise.all(completed);
  assert.deepEqual(
    results.map((r) => r.code),
    [0, 0],
    results.map((r) => r.err).join("\n"),
  );
  assert.equal(results.filter((r) => JSON.parse(r.out).receipt !== null).length, 1);

  const db = openDurableDatabase({ paths: f.paths });
  assert.equal(
    (db.prepare("SELECT count(*) n FROM workspace WHERE id IN ('w1','w2')").get() as { n: number })
      .n,
    2,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT count(*) n FROM migration_ledger WHERE source='workspaces_json' AND state='completed'",
        )
        .get() as {
        n: number;
      }
    ).n,
    1,
  );
  assert.equal(existsSync(f.source), false);
  assert.equal(migrateWorkspaceRegistry(db, f.agentDir, f.paths), undefined);
  assert.equal(
    (db.prepare("SELECT count(*) n FROM workspace WHERE id IN ('w1','w2')").get() as { n: number })
      .n,
    2,
  );
  db.close();
});

test("migration keeps same-name records from distinct repositories and retains source on duplicate id", () => {
  const f = fixture();
  const records = [
    valid[0],
    { ...valid[0], id: "w2", repoRoot: "/tmp/repo-two", path: "/tmp/w2" },
    { ...valid[0], name: "duplicate", repoRoot: "/tmp/repo-three", path: "/tmp/w3" },
  ];
  writeFileSync(f.source, JSON.stringify(records));
  assert.equal(migrateWorkspaceRegistry(f.db, f.agentDir, f.paths), undefined);
  assert.ok(existsSync(f.source), "unresolved source must remain intact");
  const rows = f.db.prepare("SELECT id,name,repo_id FROM workspace ORDER BY id").all() as any[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "same");
  assert.equal(rows[1].name, "same");
  assert.notEqual(rows[0].repo_id, rows[1].repo_id);
  const collision = f.db
    .prepare("SELECT evidence FROM quarantine WHERE reason='migration_insert_collision'")
    .get() as { evidence: string };
  const evidence = JSON.parse(collision.evidence);
  assert.equal(evidence.incoming.id, "w1");
  assert.equal(evidence.conflicts.byId.id, "w1");
  assert.equal(
    (
      f.db
        .prepare("SELECT count(*) n FROM quarantine WHERE reason='migration_completed'")
        .get() as any
    ).n,
    0,
  );
  assert.equal(
    (
      f.db
        .prepare("SELECT count(*) n FROM quarantine WHERE reason='migration_unresolved'")
        .get() as any
    ).n,
    1,
  );
  f.db.close();
});

test("abandoned head refresh requires a verified receipt for the new canonical heads", () => {
  const f = fixture();
  const at = "2025-01-01T00:00:00.000Z";
  f.db.prepare("INSERT INTO pi_session VALUES(?,NULL,NULL,'unknown','',?,?)").run("s", at, at);
  f.db
    .prepare(
      "INSERT INTO custody_operation(op_id,workspace_id,kind,state,requested_by,pid,process_identity,started_at,heartbeat_at,settled_at) VALUES('op','wa','abandon','committed','user',1,'p',?,?,?)",
    )
    .run(at, at, at);
  f.db
    .prepare("INSERT INTO abandon_receipt VALUES('r1','wa','op','user','[\"kkkk\"]','a','b',1,?)")
    .run(at);
  f.db
    .prepare(
      "INSERT INTO workspace(id,name,path,repo_id,repo_root,disposition,base_change_ids,root_change_id,head_change_ids,root_session_id,created_at,updated_at) VALUES('wa','a','/a','repo_unresolved','/r','abandoned','[\"llll\"]','kkkk','[\"kkkk\"]','s',?,?)",
    )
    .run(at, at);
  assert.throws(
    () => f.db.prepare("UPDATE workspace SET head_change_ids='[\"mmmm\"]' WHERE id='wa'").run(),
    /verified abandon receipt/,
  );
  f.db
    .prepare(
      "INSERT INTO custody_operation(op_id,workspace_id,kind,state,requested_by,pid,process_identity,started_at,heartbeat_at,settled_at) VALUES('op2','wa','abandon','committed','user',1,'p',?,?,?)",
    )
    .run(at, at, at);
  f.db
    .prepare("INSERT INTO abandon_receipt VALUES('r2','wa','op2','user','[\"mmmm\"]','b','c',1,?)")
    .run(at);
  f.db.prepare("UPDATE workspace SET head_change_ids='[\"mmmm\"]' WHERE id='wa'").run();
  assert.equal(
    (f.db.prepare("SELECT head_change_ids h FROM workspace WHERE id='wa'").get() as any).h,
    '["mmmm"]',
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
