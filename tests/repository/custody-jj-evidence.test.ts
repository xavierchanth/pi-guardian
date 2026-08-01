import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JjCli } from "../../packages/pi-tai/src/core/isolation/jj.ts";
import { SqliteWorkspaceCustody } from "../../packages/pi-tai/src/core/isolation/sqlite-custody.ts";
import { JjProcessExecutor } from "../../packages/pi-tai/src/core/jj/executor.ts";
import { resolveStoragePaths } from "../../packages/pi-tai/src/core/storage/paths.ts";
import { openDurableDatabase } from "../../packages/pi-tai/src/core/storage/sqlite.ts";

const run = (cwd: string, ...args: string[]) =>
  execFileSync("jj", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  }).trim();
function repo(prefix = "pitai-jj-") {
  const path = mkdtempSync(join(tmpdir(), prefix));
  run(path, "git", "init", "--colocate");
  return path;
}
const cli = () => new JjCli(new JjProcessExecutor());

test("K1 real JJ 0.43 workspaceHead and ownedHeads use repository-scoped evidence", async () => {
  const root = repo();
  const jj = cli();
  const base = await jj.changeIdAt(root, "@");
  const attached = join(tmpdir(), `pitai-attached-${process.pid}-${Date.now()}`);
  await jj.workspaceAdd(root, attached, "pitai-same", [base]);
  const head = await jj.workspaceHead(root, "pitai-same");
  assert.ok(head);
  assert.deepEqual(await jj.ownedHeads(root, [base], "pitai-same", []), [head]);
  assert.equal(await jj.workspaceHead(root, "pitai-absent"), undefined);

  const second = repo("pitai-jj-second-");
  const secondBase = await jj.changeIdAt(second, "@");
  const secondAttached = join(tmpdir(), `pitai-attached-2-${process.pid}-${Date.now()}`);
  await jj.workspaceAdd(second, secondAttached, "pitai-same", [secondBase]);
  assert.notEqual(await jj.workspaceHead(second, "pitai-same"), head);
});

test("K2 real JJ evidence distinguishes unique, hidden, unknown and divergent Change IDs", async () => {
  const root = repo();
  const jj = cli();
  const unique = await jj.changeIdAt(root, "@");
  assert.equal((await jj.resolveChange(root, unique)).kind, "unique");
  await jj.abandon(root, unique);
  assert.equal((await jj.resolveChange(root, unique)).kind, "hidden");
  assert.equal((await jj.resolveChange(root, "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq")).kind, "unknown");

  run(root, "new");
  const divergent = await jj.changeIdAt(root, "@");
  const before = run(root, "operation", "log", "--limit", "1", "--no-graph", "-T", "id");
  run(root, "--ignore-working-copy", "describe", "-m", "branch-a", "@");
  run(root, "--at-operation", before, "--ignore-working-copy", "describe", "-m", "branch-b", "@");
  // Reading at the current operation reconciles the two concurrent operation heads.
  run(root, "operation", "log", "--limit", "1");
  const evidence = await jj.resolveChange(root, divergent);
  assert.equal(evidence.kind, "divergent");
  if (evidence.kind === "divergent") assert.equal(evidence.commitIds.length, 2);
});

test("K3 validated canonical repository roots produce stable, repository-distinct fingerprints", async () => {
  const one = repo();
  const two = repo();
  const jj = cli();
  assert.equal(await jj.repositoryRoot(join(one, ".jj")), realpathSync(one));
  const oneRoots = await jj.repositoryRoots(one);
  const twoRoots = await jj.repositoryRoots(two);
  assert.equal(oneRoots.truncated, false);
  assert.ok(oneRoots.roots.length > 0);

  const home = mkdtempSync(join(tmpdir(), "pitai-custody-evidence-"));
  const db = openDurableDatabase({ paths: resolveStoragePaths({}, home) });
  const custody = new SqliteWorkspaceCustody(db);
  const a = await custody.establishRepository({
    roots: oneRoots.roots,
    rootsTruncated: oneRoots.truncated,
    canonicalRoot: one,
    storeKey: realpathSync(join(one, ".git")),
    now: new Date().toISOString(),
  });
  const alias = await custody.establishRepository({
    roots: oneRoots.roots,
    rootsTruncated: oneRoots.truncated,
    canonicalRoot: one,
    storeKey: realpathSync(join(one, ".git")),
    now: new Date().toISOString(),
  });
  const b = await custody.establishRepository({
    roots: twoRoots.roots,
    rootsTruncated: twoRoots.truncated,
    canonicalRoot: two,
    storeKey: realpathSync(join(two, ".git")),
    now: new Date().toISOString(),
  });
  assert.equal(a.repoId, alias.repoId);
  assert.notEqual(a.repoId, b.repoId);
  db.close();
});

test("K4 infrastructure failures propagate rather than becoming absent workspace evidence", async () => {
  const root = repo();
  const broken = new JjCli(new JjProcessExecutor({ binary: join(root, "missing-jj") }));
  await assert.rejects(
    broken.workspaceHead(root, "pitai-any"),
    /not found|spawn|ENOENT|unavailable/i,
  );
});
