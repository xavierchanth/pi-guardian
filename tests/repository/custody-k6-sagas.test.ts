import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CustodyRecord } from "../../packages/pi-tai/src/core/isolation/custody-port.ts";
import {
  SQLiteCustodyCoordinator,
  type CustodySagaRequest,
} from "../../packages/pi-tai/src/core/isolation/sqlite-custody-coordinator.ts";
import { JjCli } from "../../packages/pi-tai/src/core/isolation/jj.ts";
import { SqliteWorkspaceCustody } from "../../packages/pi-tai/src/core/isolation/sqlite-custody.ts";
import { JjProcessExecutor } from "../../packages/pi-tai/src/core/jj/executor.ts";
import { resolveStoragePaths } from "../../packages/pi-tai/src/core/storage/paths.ts";
import { openDurableDatabase } from "../../packages/pi-tai/src/core/storage/sqlite.ts";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("jj", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  }).trim();
const jj = () => new JjCli(new JjProcessExecutor());
const now = "2026-02-01T00:00:00.000Z";

async function fixture(attached = true) {
  const home = mkdtempSync(join(tmpdir(), "pitai-k6-"));
  const root = join(home, "repo");
  mkdirSync(root);
  sh(root, "git", "init", "--colocate");
  const cli = jj();
  const base = await cli.changeIdAt(root, "@");
  const db = openDurableDatabase({ paths: resolveStoragePaths({}, home) });
  const port = new SqliteWorkspaceCustody(db);
  db.prepare("INSERT INTO pi_session VALUES(?,NULL,NULL,'startup',?,?,?)").run(
    "session",
    root,
    now,
    now,
  );
  const roots = await cli.repositoryRoots(root);
  const identity = await port.establishRepository({
    roots: roots.roots,
    rootsTruncated: roots.truncated,
    canonicalRoot: root,
    storeKey: join(root, ".git"),
    now,
  });
  const path = join(home, "worker");
  let head = base;
  if (attached) {
    await cli.workspaceAdd(root, path, "pitai-worker", [base]);
    head = (await cli.workspaceHead(root, "pitai-worker"))!;
  }
  const record: CustodyRecord = {
    id: "worker",
    name: "pitai-worker",
    path,
    repoId: identity.repoId,
    repoRoot: root,
    disposition: "attached",
    attachmentEvidence: attached ? "present" : "absent",
    directoryEvidence: attached ? "present" : "absent",
    baseChangeIds: [base],
    rootChangeId: attached ? head : undefined,
    headChangeIds: attached ? [head] : [],
    conflictRetained: false,
    rootSessionId: "session",
    quarantined: false,
    attention: false,
    createdAt: now,
    updatedAt: now,
  };
  if (attached)
    await port.insert(record, {
      opId: `seed-${Math.random()}`,
      workspaceId: record.id,
      repoId: record.repoId,
      kind: "create",
      requestedBy: "system_spawn",
      pid: process.pid,
      processIdentity: "seed",
      changeIds: [head],
      now,
    });
  return { home, root, db, port, cli, record, base, head };
}
const request = (
  f: Awaited<ReturnType<typeof fixture>>,
  kind: CustodySagaRequest["kind"],
): CustodySagaRequest => ({
  kind,
  workspaceId: "worker",
  repoId: f.record.repoId,
  repoRoot: f.root,
  rootSessionId: "session",
  requestedBy: kind === "abandon" ? "user" : "system_settle",
});

for (const kind of ["create", "forget", "abandon", "merge"] as const) {
  for (const boundary of ["after_intent", "after_jj", "after_receipt", "after_commit"] as const) {
    test(`K6 ${kind} recovers idempotently at ${boundary}`, async () => {
      const f = await fixture(kind !== "create");
      let req = request(f, kind);
      if (kind === "create") req = { ...req, requestedBy: "system_spawn", record: f.record };
      if (kind === "merge") {
        sh(f.root, "new");
        req = { ...req, targetChangeId: await f.cli.changeIdAt(f.root, "@"), targetPath: f.root };
      }
      let fired = false;
      const crashing = new SQLiteCustodyCoordinator(
        f.db,
        f.port,
        f.cli,
        "crasher",
        () => now,
        (at) => {
          if (!fired && at === boundary) {
            fired = true;
            throw new Error(`crash:${at}`);
          }
        },
      );
      await assert.rejects(crashing.run(req), /crash:/);
      const recovering = new SQLiteCustodyCoordinator(f.db, f.port, f.cli, "recoverer", () => now);
      assert.deepEqual((await recovering.recover(f.record.repoId)).failed, []);
      assert.deepEqual((await recovering.recover(f.record.repoId)).failed, []);
      const row = await f.port.get("worker");
      assert.ok(row);
      assert.equal(
        row.disposition,
        kind === "merge"
          ? "merged"
          : kind === "abandon"
            ? "abandoned"
            : kind === "forget"
              ? "detached"
              : "attached",
      );
      if (kind !== "create") assert.equal(existsSync(f.record.path), false);
      f.db.close();
    });
  }
}

test("K6 scaffold mutation after intent is retained and recovery continues after a failed op", async () => {
  const f = await fixture();
  const coordinator = new SQLiteCustodyCoordinator(
    f.db,
    f.port,
    f.cli,
    "crash",
    () => now,
    (at) => {
      if (at === "after_intent") throw new Error("crash:after_intent");
    },
  );
  await assert.rejects(
    coordinator.reclaimScaffold({
      workspaceId: "worker",
      repoId: f.record.repoId,
      repoRoot: f.root,
      rootSessionId: "session",
    }),
    /crash/,
  );
  await f.cli.describe(f.root, f.head, "user mutation");
  const second = await fixture();
  // Put a valid open operation after the poisoned one to prove the scanner advances.
  const valid = request(second, "forget");
  let tripped = false;
  const c2 = new SQLiteCustodyCoordinator(
    second.db,
    second.port,
    second.cli,
    "x",
    () => now,
    (at) => {
      if (!tripped && at === "after_intent") {
        tripped = true;
        throw new Error("stop");
      }
    },
  );
  await assert.rejects(c2.run(valid));
  // The same property is asserted in each database; the poisoned scaffold is refused.
  const result = await new SQLiteCustodyCoordinator(f.db, f.port, f.cli).recover();
  assert.equal(result.failed.length, 1);
  assert.equal((await f.port.get("worker"))!.disposition, "attached");
  assert.ok(existsSync(f.record.path));
  assert.equal(
    (await new SQLiteCustodyCoordinator(second.db, second.port, second.cli).recover()).recovered
      .length,
    1,
  );
  f.db.close();
  second.db.close();
});

test("K6 explicit abandon refuses an owned head with descendants and preserves directory", async () => {
  const f = await fixture();
  sh(f.root, "new", f.head);
  await assert.rejects(
    new SQLiteCustodyCoordinator(f.db, f.port, f.cli).run(request(f, "abandon")),
    /descendants/,
  );
  assert.ok(existsSync(f.record.path));
  f.db.close();
});
