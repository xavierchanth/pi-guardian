import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
  // Never use JJ's synthetic root as a merge parent (the colocated Git backend
  // intentionally rejects that shape). A tracked seed also makes divergent
  // edits exercise JJ's real conflict machinery rather than add/add heuristics.
  writeFileSync(join(root, "shared.txt"), "seed\n");
  sh(root, "new");
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

const operationCount = (root: string) =>
  Number(sh(root, "operation", "log", "--no-graph", "--template", '"x\\n"').split("\n").length);

function put(path: string, value: string) {
  writeFileSync(join(path, "shared.txt"), value);
  // Materialize the filesystem edit in that workspace's JJ commit. Commands in
  // a different workspace only snapshot their own working copy.
  sh(path, "status");
}

async function mergeRequest(f: Awaited<ReturnType<typeof fixture>>, targetPath = f.root) {
  return {
    ...request(f, "merge"),
    targetPath,
    targetChangeId: await f.cli.changeIdAt(targetPath, "@"),
  } satisfies CustodySagaRequest;
}

async function runChild(script: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script, ...args],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let error = "";
    child.stderr.on("data", (chunk) => {
      error += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(error))));
  });
}

test("K6 two processes lease one duplicate operation and converge on one receipt and row", async () => {
  const f = await fixture();
  f.db.close();
  const before = operationCount(f.root);
  const coordinatorUrl = new URL(
    "../../packages/pi-tai/src/core/isolation/sqlite-custody-coordinator.ts",
    import.meta.url,
  ).href;
  const custodyUrl = new URL(
    "../../packages/pi-tai/src/core/isolation/sqlite-custody.ts",
    import.meta.url,
  ).href;
  const jjUrl = new URL("../../packages/pi-tai/src/core/isolation/jj.ts", import.meta.url).href;
  const executorUrl = new URL("../../packages/pi-tai/src/core/jj/executor.ts", import.meta.url)
    .href;
  const pathsUrl = new URL("../../packages/pi-tai/src/core/storage/paths.ts", import.meta.url).href;
  const sqliteUrl = new URL("../../packages/pi-tai/src/core/storage/sqlite.ts", import.meta.url)
    .href;
  const child = `
    import { SQLiteCustodyCoordinator } from ${JSON.stringify(coordinatorUrl)};
    import { SqliteWorkspaceCustody } from ${JSON.stringify(custodyUrl)};
    import { JjCli } from ${JSON.stringify(jjUrl)};
    import { JjProcessExecutor } from ${JSON.stringify(executorUrl)};
    import { resolveStoragePaths } from ${JSON.stringify(pathsUrl)};
    import { openDurableDatabase } from ${JSON.stringify(sqliteUrl)};
    const [home, root, repoId] = process.argv.slice(1);
    const db = openDurableDatabase({paths: resolveStoragePaths({}, home)});
    await new SQLiteCustodyCoordinator(db, new SqliteWorkspaceCustody(db), new JjCli(new JjProcessExecutor()), String(process.pid)).run({kind:"forget",workspaceId:"worker",repoId,repoRoot:root,rootSessionId:"session",requestedBy:"system_settle"});
    db.close();`;
  await Promise.all([
    runChild(child, [f.home, f.root, f.record.repoId]),
    runChild(child, [f.home, f.root, f.record.repoId]),
  ]);
  const db = openDurableDatabase({ paths: resolveStoragePaths({}, f.home) });
  const row = await new SqliteWorkspaceCustody(db).get("worker");
  assert.equal(operationCount(f.root) - before, 1, "workspace forget is the sole JJ mutation");
  assert.equal(row?.disposition, "detached");
  const operations = db
    .prepare("SELECT count(*) n FROM custody_operation WHERE kind='forget'")
    .get() as { n: number };
  assert.equal(operations.n, 1);
  assert.equal(existsSync(f.record.path), false);
  db.close();
});

test("K6 auto merge-under preserves a dirty target", async () => {
  const f = await fixture();
  put(f.record.path, "agent\n");
  put(f.root, "target\n");
  const target = await f.cli.changeIdAt(f.root, "@");
  const result = await new SQLiteCustodyCoordinator(f.db, f.port, f.cli).run(await mergeRequest(f));
  assert.equal(result.disposition, "attached", "conflict retains custody");
  assert.equal(result.conflictRetained, true);
  assert.equal(await f.cli.areAncestorsOf(f.root, [f.head], target), true);
  assert.ok(existsSync(f.record.path));
  f.db.close();
});

test("K6 merge targets a nested parent workspace", async () => {
  const f = await fixture();
  put(f.record.path, "agent\n");
  const parent = join(f.home, "parent");
  await f.cli.workspaceAdd(f.root, parent, "pitai-parent", [f.base]);
  writeFileSync(join(parent, "parent-only.txt"), "parent-only\n");
  sh(parent, "status");
  const target = await f.cli.changeIdAt(parent, "@");
  const result = await new SQLiteCustodyCoordinator(f.db, f.port, f.cli).run(
    await mergeRequest(f, parent),
  );
  assert.equal(result.disposition, "merged");
  assert.equal(result.conflictRetained, false);
  assert.equal(await f.cli.areAncestorsOf(parent, [f.head], target), true);
  f.db.close();
});

test("K6 linear conflict restores then falls back, retaining attachment and path", async () => {
  const f = await fixture();
  // Both commits descend from a base which already owns the path, forcing a
  // conflict during speculative insert-before while the target itself is empty.
  sh(f.root, "new", f.base);
  put(f.root, "target\n");
  sh(f.root, "new");
  put(f.record.path, "agent\n");
  const target = await f.cli.changeIdAt(f.root, "@");
  const parentBefore = await f.cli.parentsOfWorkingCopy(f.root);
  const result = await new SQLiteCustodyCoordinator(f.db, f.port, f.cli).run(await mergeRequest(f));
  assert.equal(result.disposition, "attached");
  assert.equal(result.conflictRetained, true);
  assert.ok(existsSync(f.record.path));
  assert.ok(await f.cli.workspaceHead(f.root, f.record.name));
  assert.notDeepEqual(await f.cli.parentsOfWorkingCopy(f.root), parentBefore);
  assert.equal(await f.cli.areAncestorsOf(f.root, [f.head], target), true);
  f.db.close();
});

test("K6 resolved conflict retry proves ancestry then safely detaches", async () => {
  const f = await fixture();
  put(f.record.path, "agent\n");
  put(f.root, "target\n");
  const first = await mergeRequest(f);
  const coordinator = new SQLiteCustodyCoordinator(f.db, f.port, f.cli);
  assert.equal((await coordinator.run(first)).conflictRetained, true);
  put(f.root, "resolved\n");
  assert.equal((await f.cli.conflictedPaths(f.root)).length, 0);
  const result = await coordinator.run({ ...first, kind: "finalize_merge" });
  assert.equal(result.disposition, "merged");
  assert.equal(await f.cli.areAncestorsOf(f.root, [f.head], first.targetChangeId!), true);
  assert.equal(await f.cli.workspaceHead(f.root, f.record.name), undefined);
  assert.equal(existsSync(f.record.path), false);
  f.db.close();
});

test("K6 merge folds multiple owned heads under a multi-parent target", async () => {
  const f = await fixture();
  writeFileSync(join(f.record.path, "one.txt"), "one\n");
  sh(f.record.path, "status");
  const otherPath = join(f.home, "other");
  await f.cli.workspaceAdd(f.root, otherPath, "pitai-other", [f.base]);
  writeFileSync(join(otherPath, "two.txt"), "two\n");
  sh(otherPath, "status");
  const other = (await f.cli.workspaceHead(f.root, "pitai-other"))!;
  const heads = [f.head, other];
  f.db
    .prepare("UPDATE workspace SET head_change_ids=? WHERE id='worker'")
    .run(JSON.stringify(heads));
  sh(f.root, "new", f.base, f.head);
  const target = await f.cli.changeIdAt(f.root, "@");
  const result = await new SQLiteCustodyCoordinator(f.db, f.port, f.cli).run(await mergeRequest(f));
  assert.equal(result.disposition, "merged");
  assert.equal(await f.cli.areAncestorsOf(f.root, [f.head, other], target), true);
  f.db.close();
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
