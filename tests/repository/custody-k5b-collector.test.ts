import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { repositoryStoreKey } from "../../packages/pi-tai/src/core/isolation/custody-evidence.ts";
import { JjCli } from "../../packages/pi-tai/src/core/isolation/jj.ts";
import { SqliteWorkspaceCustody } from "../../packages/pi-tai/src/core/isolation/sqlite-custody.ts";
import { JjProcessExecutor } from "../../packages/pi-tai/src/core/jj/executor.ts";
import { resolveStoragePaths } from "../../packages/pi-tai/src/core/storage/paths.ts";
import { openDurableDatabase } from "../../packages/pi-tai/src/core/storage/sqlite.ts";

const run = (cwd: string, ...args: string[]) =>
  execFileSync("jj", args, { cwd, encoding: "utf8" }).trim();
const cli = () => new JjCli(new JjProcessExecutor());
function repo(home: string, name: string) {
  const p = join(home, name);
  mkdirSync(p);
  run(p, "git", "init", "--colocate");
  return p;
}

async function collect(jj: JjCli, root: string) {
  const evidence = await jj.repositoryRoots(root);
  return {
    roots: evidence.roots,
    rootsTruncated: evidence.truncated,
    canonicalRoot: await jj.repositoryRoot(root),
    storeKey: await repositoryStoreKey(root),
    now: "2026-02-01",
  };
}

test("K5b collector baseline is stable for same repository and unique across repositories", async () => {
  const home = mkdtempSync(join(tmpdir(), "pitai-k5b-"));
  const a = repo(home, "a"),
    b = repo(home, "b"),
    j = cli();
  const db = openDurableDatabase({ paths: resolveStoragePaths({}, home) }),
    port = new SqliteWorkspaceCustody(db);
  const first = await port.establishRepository(await collect(j, a));
  assert.equal((await port.establishRepository(await collect(j, a))).repoId, first.repoId);
  assert.notEqual((await port.establishRepository(await collect(j, b))).repoId, first.repoId);
  db.close();
});

test("K5b linked JJ workspaces use their shared repository store identity", async () => {
  const home = mkdtempSync(join(tmpdir(), "pitai-k5b-linked-"));
  const root = repo(home, "root");
  const linked = join(home, "linked");
  run(root, "workspace", "add", linked, "--name", "linked");
  assert.equal(await repositoryStoreKey(root), await repositoryStoreKey(linked));
});

test("K5b collector keeps identity across root growth, multiple heads, and relocation", async () => {
  const home = mkdtempSync(join(tmpdir(), "pitai-k5b-growth-"));
  const root = repo(home, "original"),
    j = cli();
  const db = openDurableDatabase({ paths: resolveStoragePaths({}, home) }),
    port = new SqliteWorkspaceCustody(db);
  const original = await port.establishRepository(await collect(j, root));
  run(root, "new");
  run(root, "bookmark", "create", "head-one", "-r", "@");
  run(root, "new", "root()");
  run(root, "bookmark", "create", "head-two", "-r", "@");
  const grown = await collect(j, root);
  assert.ok(grown.roots.length >= 1);
  assert.equal((await port.establishRepository(grown)).repoId, original.repoId);
  const moved = join(home, "relocated");
  renameSync(root, moved);
  assert.equal((await port.establishRepository(await collect(j, moved))).repoId, original.repoId);
  db.close();
});
