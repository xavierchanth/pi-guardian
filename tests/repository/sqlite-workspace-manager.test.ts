import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { JjProcessExecutor } from "../../packages/pi-tai/src/core/jj/executor.ts";
import { JjCli } from "../../packages/pi-tai/src/core/isolation/jj.ts";
import { SQLiteCustodyCoordinator } from "../../packages/pi-tai/src/core/isolation/sqlite-custody-coordinator.ts";
import { SqliteWorkspaceCustody } from "../../packages/pi-tai/src/core/isolation/sqlite-custody.ts";
import { SQLiteWorkspaceManager } from "../../packages/pi-tai/src/core/isolation/sqlite-workspace-manager.ts";
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
  writeFileSync(join(child.path, "work.txt"), "content\n");
  sh(child.path, "describe", "-m", "work");
  assert.equal((await f.manager.pendingChanges(child.id))?.length, 1);
  assert.equal((await f.manager.get(child.id))?.ownerDisplayId, "Worker");
  assert.equal((await f.manager.list()).length, 2);
  assert.equal((await f.manager.resolveCustody(child.id))?.phase, "active");

  const receipt = await f.manager.discard(child.id);
  assert.equal(receipt.discardedChangeIds.length, 1);
  assert.equal((await f.manager.get(child.id))?.phase, "discarded");

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
  assert.equal((await reopened.get(child.id))?.phase, "discarded");
  const swept = await reopened.sweep(["owner"]);
  assert.ok(swept.some((entry) => entry.id === parent.id));
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
