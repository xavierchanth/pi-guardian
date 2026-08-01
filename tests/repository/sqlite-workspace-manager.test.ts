import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { JjCli } from "../../packages/pi-tai/src/core/isolation/jj.ts";
import { SqliteWorkspaceCustody } from "../../packages/pi-tai/src/core/isolation/sqlite-custody.ts";
import { SQLiteCustodyCoordinator } from "../../packages/pi-tai/src/core/isolation/sqlite-custody-coordinator.ts";
import { SQLiteWorkspaceManager } from "../../packages/pi-tai/src/core/isolation/sqlite-workspace-manager.ts";
import { JjProcessExecutor } from "../../packages/pi-tai/src/core/jj/executor.ts";
import { resolveStoragePaths } from "../../packages/pi-tai/src/core/storage/paths.ts";
import { openDurableDatabase } from "../../packages/pi-tai/src/core/storage/sqlite.ts";

const homes: string[] = [];
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("jj", args, { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture(home = mkdtempSync(join(tmpdir(), "pitai-k7a-"))) {
  homes.push(home);
  const source = join(home, "repo");
  mkdirSync(source, { recursive: true });
  sh(source, "git", "init", "--colocate");
  writeFileSync(join(source, "base.txt"), "base\n");
  sh(source, "describe", "-m", "base");
  sh(source, "new");
  const db = openDurableDatabase({ paths: resolveStoragePaths({}, home) });
  const custody = new SqliteWorkspaceCustody(db);
  const jj = new JjCli(new JjProcessExecutor());
  const session = "root-session";
  const now = new Date().toISOString();
  db.prepare("INSERT INTO pi_session VALUES(?,NULL,NULL,'startup',?,?,?)").run(
    session,
    source,
    now,
    now,
  );
  const coordinator = new SQLiteCustodyCoordinator(db, custody, jj);
  const manager = new SQLiteWorkspaceManager({
    jj,
    custody,
    coordinator,
    sourcePath: source,
    workspaceRoot: join(home, "workspaces"),
    rootSessionId: session,
  });
  return { home, source, db, custody, jj, session, manager };
}

test("SQLite adapter exercises metadata, continuation, pending, discard, sweep and reopen", async () => {
  const f = fixture();
  const parent = await f.manager.create({ label: "parent" });
  const child = await f.manager.create({ label: "child", parent: parent.id, ownerId: "old" });
  await f.manager.assignOwner(child.id, "owner", "Worker");
  await f.manager.assignParent(child.id, parent.id);
  assert.deepEqual(
    f.db
      .prepare(
        "SELECT kind,requested_by FROM custody_operation WHERE workspace_id=? AND kind LIKE 'assign_%' ORDER BY started_at, rowid",
      )
      .all(child.id)
      .map((row) => ({ ...(row as { kind: string; requested_by: string }) })),
    [
      { kind: "assign_owner", requested_by: "system_spawn" },
      { kind: "assign_parent", requested_by: "system_spawn" },
    ],
  );
  writeFileSync(join(child.path, "work.txt"), "content\n");
  sh(child.path, "describe", "-m", "work");
  assert.equal((await f.manager.pendingChanges(child.id))?.length, 1);
  assert.equal((await f.manager.get(child.id))?.ownerDisplayId, "Worker");
  assert.equal((await f.manager.list()).length, 2);
  assert.equal((await f.manager.resolveCustody(child.id))?.phase, "active");

  const receipt = await f.manager.discard(child.id);
  assert.equal(receipt.discardedChangeIds.length, 1);
  assert.equal((await f.manager.get(child.id))?.phase, "abandoned");

  // Reconstruct both port and facade over the same durable database.
  const reopenedPort = new SqliteWorkspaceCustody(f.db);
  const reopened = new SQLiteWorkspaceManager({
    jj: f.jj,
    custody: reopenedPort,
    coordinator: new SQLiteCustodyCoordinator(f.db, reopenedPort, f.jj),
    sourcePath: f.source,
    workspaceRoot: join(f.home, "workspaces"),
    rootSessionId: f.session,
  });
  assert.equal((await reopened.get(child.id))?.phase, "abandoned");
  const swept = await reopened.sweep(["owner"]);
  assert.ok(swept.some((entry) => entry.id === parent.id));
});

test("adapter reopens and recovers create after every coordinator crash boundary", async () => {
  for (const boundary of ["after_intent", "after_jj", "after_receipt", "after_commit"] as const) {
    const f = fixture();
    let fired = false;
    const crashing = new SQLiteWorkspaceManager({
      jj: f.jj,
      custody: f.custody,
      coordinator: new SQLiteCustodyCoordinator(
        f.db,
        f.custody,
        f.jj,
        `${process.pid}:crash-${boundary}`,
        () => new Date().toISOString(),
        (at) => {
          if (!fired && at === boundary) {
            fired = true;
            throw new Error(`crash:${at}`);
          }
        },
      ),
      sourcePath: f.source,
      workspaceRoot: join(f.home, "workspaces"),
      rootSessionId: f.session,
    });
    await assert.rejects(
      () => crashing.create({ label: boundary }),
      new RegExp(`crash:${boundary}`),
    );
    const reopenedPort = new SqliteWorkspaceCustody(f.db);
    const recovery = new SQLiteCustodyCoordinator(f.db, reopenedPort, f.jj);
    const result = await recovery.recover();
    assert.equal(result.failed.length, 0);
    const reopened = new SQLiteWorkspaceManager({
      jj: f.jj,
      custody: reopenedPort,
      coordinator: recovery,
      sourcePath: f.source,
      workspaceRoot: join(f.home, "workspaces"),
      rootSessionId: f.session,
    });
    assert.equal((await reopened.list()).length, 1);
  }
});

test("adapter no_changes reclaims its scaffold and reports the settled record", async () => {
  const f = fixture();
  const workspace = await f.manager.create({ label: "empty" });
  const result = await f.manager.merge(workspace.id);
  assert.equal(result.kind, "no_changes");
  assert.equal(result.record.phase, "abandoned");
  assert.equal((await f.manager.get(workspace.id))?.phase, "abandoned");
});

test("durable Change IDs survive checkout deletion and forgotten JJ attachment", async () => {
  const f = fixture();
  const workspace = await f.manager.create({ label: "path-is-not-authority" });
  writeFileSync(join(workspace.path, "survives.txt"), "durable\n");
  sh(workspace.path, "describe", "-m", "survives deletion");
  await f.manager.resolveCustody(workspace.id); // persist the actual owned head
  sh(f.source, "workspace", "forget", workspace.name);
  rmSync(workspace.path, { recursive: true, force: true });
  assert.deepEqual(
    (await f.manager.pendingChanges(workspace.id))?.map((x) => x.description),
    ["survives deletion"],
  );
  assert.equal((await f.manager.merge(workspace.id)).kind, "merged");
});

test("real JJ retains a linear conflict and finalizes it after resolution", async () => {
  const f = fixture();
  const workspace = await f.manager.create({ label: "conflict" });
  writeFileSync(join(workspace.path, "base.txt"), "workspace\n");
  sh(workspace.path, "describe", "-m", "workspace side");
  writeFileSync(join(f.source, "base.txt"), "target\n");
  sh(f.source, "describe", "-m", "target side");
  const first = await f.manager.merge(workspace.id);
  assert.equal(first.kind, "retained_conflicts");
  assert.ok(first.summary.conflictPaths.includes("base.txt"));
  writeFileSync(join(f.source, "base.txt"), "resolved\n");
  const second = await f.manager.merge(workspace.id);
  assert.equal(second.kind, "merged");
});

test("multiple independent owned heads and nested parent workspace merge through adapter", async () => {
  const f = fixture();
  const a = await f.manager.create({ label: "a" });
  const b = await f.manager.create({ label: "b" });
  writeFileSync(join(a.path, "a.txt"), "a\n");
  writeFileSync(join(b.path, "b.txt"), "b\n");
  sh(a.path, "describe", "-m", "independent a");
  sh(b.path, "describe", "-m", "independent b");
  assert.equal((await f.manager.merge(a.id)).kind, "merged");
  assert.equal((await f.manager.merge(b.id)).kind, "merged");

  const parent = await f.manager.create({ label: "nested-parent" });
  const child = await f.manager.create({ label: "nested-child", parent: parent.id });
  writeFileSync(join(child.path, "nested.txt"), "nested\n");
  sh(child.path, "describe", "-m", "nested child");
  assert.equal((await f.manager.merge(child.id)).kind, "merged");
  assert.ok(
    (await f.manager.pendingChanges(parent.id))?.some((x) => x.description.includes("nested")),
  );
});

test("SQLite adapter serializes duplicate settlement and refuses foreign-root mutation", async () => {
  const f = fixture();
  const workspace = await f.manager.create({ label: "race" });
  writeFileSync(join(workspace.path, "change.txt"), "change\n");
  sh(workspace.path, "describe", "-m", "change");
  const [a, b] = await Promise.all([f.manager.merge(workspace.id), f.manager.merge(workspace.id)]);
  assert.equal(a.kind, "merged");
  assert.equal(b.kind, "blocked");

  const foreign = new SQLiteWorkspaceManager({
    jj: f.jj,
    custody: f.custody,
    coordinator: new SQLiteCustodyCoordinator(f.db, f.custody, f.jj),
    sourcePath: f.source,
    workspaceRoot: join(f.home, "workspaces"),
    rootSessionId: "another-root",
  });
  await assert.rejects(() => foreign.assignOwner(workspace.id, "thief"), /another root/);
});
