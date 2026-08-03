import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  executeLegacyMigration,
  LEGACY_CONFIRM_BYTES,
  planLegacyMigration,
} from "../../packages/pi-tai/src/core/storage/legacy-migration.ts";
import {
  ensurePrivateDirectory,
  ensureStoragePaths,
  privateChild,
  resolveStoragePaths,
  resolveXdgRoots,
} from "../../packages/pi-tai/src/core/storage/paths.ts";
import {
  openDurableDatabase,
  SCHEMA_SQL,
  SqliteDurableRecordStore,
} from "../../packages/pi-tai/src/core/storage/sqlite.ts";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pi-tai-storage-"));
  const paths = resolveStoragePaths({}, home);
  return { home, paths };
}
test("XDG root authority resolves fallbacks and independent partial overrides", () => {
  const { home } = fixture();
  const state = resolve(tmpdir(), "xdg-state");
  const data = resolve(tmpdir(), "xdg-data");
  const cache = resolve(tmpdir(), "xdg-cache");
  const runtime = resolve(tmpdir(), "xdg-runtime");
  const cases = [
    {
      env: {},
      expected: {
        state: join(home, ".local", "state"),
        data: join(home, ".local", "share"),
        cache: join(home, ".cache"),
        runtime: join(home, ".cache"),
        runtimeFromCache: true,
      },
    },
    {
      env: { XDG_STATE_HOME: state },
      expected: {
        state,
        data: join(home, ".local", "share"),
        cache: join(home, ".cache"),
        runtime: join(home, ".cache"),
        runtimeFromCache: true,
      },
    },
    {
      env: { XDG_DATA_HOME: data, XDG_CACHE_HOME: "relative", XDG_RUNTIME_DIR: "relative" },
      expected: {
        state: join(home, ".local", "state"),
        data,
        cache: join(home, ".cache"),
        runtime: join(home, ".cache"),
        runtimeFromCache: true,
      },
    },
    {
      env: { XDG_CACHE_HOME: cache },
      expected: {
        state: join(home, ".local", "state"),
        data: join(home, ".local", "share"),
        cache,
        runtime: cache,
        runtimeFromCache: true,
      },
    },
    {
      env: { XDG_RUNTIME_DIR: runtime },
      expected: {
        state: join(home, ".local", "state"),
        data: join(home, ".local", "share"),
        cache: join(home, ".cache"),
        runtime,
        runtimeFromCache: false,
      },
    },
  ];
  for (const { env, expected } of cases) assert.deepEqual(resolveXdgRoots(env, home), expected);
});

test("absolute XDG roots win and default fallbacks append beneath os.homedir", () => {
  const root = resolve(tmpdir(), "pi-tai-explicit-xdg");
  const paths = resolveStoragePaths({
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
  });
  assert.equal(paths.database, join(root, "state", "pi-tai", "state.sqlite3"));
  assert.equal(paths.sessions, join(root, "data", "pi-tai", "sessions"));
  assert.equal(paths.runtime, join(root, "runtime", "pi-tai"));

  const fallback = resolveStoragePaths({});
  assert.equal(fallback.state, join(homedir(), ".local", "state", "pi-tai"));
  assert.equal(fallback.data, join(homedir(), ".local", "share", "pi-tai"));
  assert.equal(fallback.cache, join(homedir(), ".cache", "pi-tai"));
});
test("storage roots are private and unsafe roots/keys are refused", () => {
  const { home, paths } = fixture();
  ensureStoragePaths(paths);
  for (const path of [paths.state, paths.data, paths.cache, paths.runtime])
    assert.equal(statSync(path).mode & 0o777, 0o700);
  assert.throws(() => privateChild(paths.sessions, ".."));
  const bad = join(home, "bad");
  mkdirSync(bad, { mode: 0o777 });
  chmodSync(bad, 0o777);
  assert.throws(() => ensurePrivateDirectory(bad), /world-writable/);
  const link = join(home, "link");
  symlinkSync(paths.state, link);
  assert.throws(() => ensurePrivateDirectory(link), /Unsafe/);
});
test("schema golden has constrained metadata and no prose columns", () => {
  for (const forbidden of [
    "report_body",
    "transcript",
    "message_body",
    "image_bytes",
    "config_json",
  ])
    assert.doesNotMatch(SCHEMA_SQL, new RegExp(forbidden, "i"));
  assert.match(SCHEMA_SQL, /CHECK\(length\(title\)<=512\)/);
  assert.match(SCHEMA_SQL, /CREATE INDEX idx_subagent_owner/);
});
test("SQLite schema enforces constraints and narrow adapter survives concurrent opens", () => {
  const { paths } = fixture();
  const db1 = openDurableDatabase({ paths });
  const db2 = openDurableDatabase({ paths });
  const one = new SqliteDurableRecordStore(db1, "root");
  const two = new SqliteDurableRecordStore(db2, "root");
  one.note({
    durableId: "d1",
    displayId: "opaque-label",
    sequence: 41,
    rootSessionId: "root",
    disposition: "running",
    updatedAt: "2026-01-01",
  });
  two.note({
    durableId: "d2",
    displayId: "also-opaque",
    sequence: 42,
    rootSessionId: "root",
    disposition: "done",
    updatedAt: "2026-01-02",
  });
  assert.equal(one.counts().total, 2);
  assert.equal(one.get("d1")?.sequence, 41);
  one.note({
    durableId: "intent",
    displayId: "no-digits",
    sequence: 43,
    rootSessionId: "root",
    disposition: "intent",
    updatedAt: "2026-01-03",
  });
  assert.equal(one.get("intent")?.disposition, "intent");
  assert.throws(() => db1.prepare("UPDATE subagent SET backend='bad' WHERE durable_id='d1'").run());
  db2.close();
  db1.close();
  assert.equal(statSync(paths.database).mode & 0o777, 0o600);
});
test("newer schema is refused without modifying it", () => {
  const { paths } = fixture();
  const db = openDurableDatabase({ paths });
  db.exec("PRAGMA user_version=999");
  db.close();
  assert.throws(() => openDurableDatabase({ paths }), /newer than supported/);
  const raw = readFileSync(paths.database);
  assert.ok(raw.length > 0);
});
test("corrupt database is quarantined and replaced", () => {
  const { paths } = fixture();
  ensurePrivateDirectory(paths.state);
  writeFileSync(paths.database, "not sqlite", { mode: 0o600 });
  const db = openDurableDatabase({ paths, now: () => new Date("2026-01-01T00:00:00Z") });
  db.close();
  assert.ok(
    existsSync(join(paths.quarantine, "state-2026-01-01T00-00-00.000Z.corrupt", "state.sqlite")),
  );
});
test("legacy migration is copy-verify, idempotent, and never relocates workspaces", () => {
  const { home, paths } = fixture();
  const legacy = join(home, ".pi/agent/pi-tai");
  const journal = join(legacy, "agents/sessions/d1/journal.jsonl");
  mkdirSync(join(legacy, "agents/workspaces/w1"), { recursive: true });
  mkdirSync(join(legacy, "agents/sessions/d1"), { recursive: true });
  writeFileSync(journal, "hello");
  symlinkSync(journal, join(legacy, "agents/sessions/d1/link"));
  writeFileSync(join(legacy, "agents/workspaces/w1/uncommitted"), "precious");
  const plan = planLegacyMigration(legacy, paths);
  assert.equal(plan.copies.length, 1);
  assert.ok(plan.skipped.some((entry) => entry.includes("symlink quarantined")));
  const receipt = executeLegacyMigration(plan, paths)!;
  assert.equal(receipt.files.length, 1);
  assert.equal(readFileSync(plan.copies[0]!.destination, "utf8"), "hello");
  executeLegacyMigration(plan, paths);
  assert.equal(readFileSync(join(legacy, "agents/workspaces/w1/uncommitted"), "utf8"), "precious");
  assert.ok(existsSync(join(legacy, "MIGRATED-TO-XDG.txt")));
});
test("large legacy migration requires explicit confirmation", () => {
  const { home, paths } = fixture();
  const legacy = join(home, "legacy");
  mkdirSync(join(legacy, "agents/sessions"), { recursive: true });
  const plan = {
    sourceRoot: legacy,
    copies: [],
    skipped: [],
    totalBytes: LEGACY_CONFIRM_BYTES + 1,
  };
  assert.throws(
    () =>
      executeLegacyMigration(
        {
          ...plan,
          copies: [
            {
              source: import.meta.filename,
              destination: join(paths.sessions, "x"),
              relativePath: "x",
              bytes: 1,
            },
          ],
        },
        paths,
      ),
    /explicit confirmation/,
  );
});
