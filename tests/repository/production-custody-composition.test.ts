import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { registerAgents } from "../../packages/pi-tai/src/core/subagents/register.ts";

const roots: string[] = [];
after(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

function host() {
  const tools = new Map<string, any>();
  const hooks = new Map<string, ((event: any, ctx: any) => any)[]>();
  const pi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    on(name: string, fn: (event: any, ctx: any) => any) {
      hooks.set(name, [...(hooks.get(name) ?? []), fn]);
    },
    sendMessage() {},
  };
  return { pi, tools, hooks };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pitai-k7b-production-"));
  roots.push(root);
  const home = join(root, "home");
  const state = join(root, "state");
  const data = join(root, "data");
  const cache = join(root, "cache");
  const repo = join(root, "repo");
  await Promise.all([home, repo].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  const previous = {
    HOME: process.env.HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  };
  Object.assign(process.env, {
    HOME: home,
    XDG_STATE_HOME: state,
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: cache,
  });
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  return { root, home, state, data, cache, repo, restore };
}

function context(repo: string, session = "root-a") {
  return {
    cwd: repo,
    modelRegistry: { find: () => ({ id: "unused" }) },
    sessionManager: { getSessionId: () => session },
  };
}

async function callStatus(h: ReturnType<typeof host>, ctx: ReturnType<typeof context>) {
  return h.tools.get("workspace_status").execute("call", {}, undefined, undefined, ctx);
}

/** Serial because this deliberately verifies the process-global XDG production resolver. */
describe("K7b production custody composition", { concurrency: false }, () => {
  it("constructs durable SQLite custody privately, partitions roots, closes/reopens, and never creates legacy JSON", async () => {
    const f = await fixture();
    try {
      const a = host();
      const b = host();
      registerAgents(a.pi as never, {
        config: { session: () => ({}) } as never,
        agentDir: join(f.home, ".pi", "agent"),
      });
      registerAgents(b.pi as never, {
        config: { session: () => ({}) } as never,
        agentDir: join(f.home, ".pi", "agent"),
      });
      assert.equal((await callStatus(a, context(f.repo, "root-a"))).details.count, 0);
      assert.equal((await callStatus(b, context(f.repo, "root-b"))).details.count, 0);
      const database = join(f.state, "pi-tai", "state.sqlite3");
      assert.equal((await stat(database)).mode & 0o777, 0o600);
      const db = new DatabaseSync(database);
      assert.ok(Number((db.prepare("PRAGMA user_version").get() as any).user_version) > 0);
      assert.deepEqual(
        db
          .prepare("SELECT session_id FROM pi_session ORDER BY session_id")
          .all()
          .map((r: any) => r.session_id),
        ["root-a", "root-b"],
      );
      db.close();
      await a.hooks.get("session_shutdown")![0]!({}, context(f.repo));
      assert.equal(
        (await callStatus(a, context(f.repo, "root-a"))).details.count,
        0,
        "shutdown permits a clean reopen",
      );
      await assert.rejects(
        stat(join(f.home, ".pi", "agent", "pi-tai", "agents", "workspaces.json")),
        /ENOENT/,
      );
    } finally {
      f.restore();
    }
  });

  it("imports legacy v2 once, preserves verified bytes, and restart is idempotent", async () => {
    const f = await fixture();
    try {
      const legacyDir = join(f.home, ".pi", "agent", "pi-tai", "agents");
      await mkdir(legacyDir, { recursive: true });
      const legacy = JSON.stringify([
        {
          version: 2,
          id: "legacy-id",
          name: "legacy",
          path: join(f.root, "legacy-ws"),
          repoRoot: f.repo,
          rootSessionId: "old-root",
          rootChangeId: "kkkk",
          baseChangeIds: ["llll"],
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ]);
      await writeFile(join(legacyDir, "workspaces.json"), legacy, { mode: 0o600 });
      for (let restart = 0; restart < 2; restart++) {
        const h = host();
        registerAgents(h.pi as never, {
          config: { session: () => ({}) } as never,
          agentDir: join(f.home, ".pi", "agent"),
        });
        await callStatus(h, context(f.repo));
        await h.hooks.get("session_shutdown")![0]!({}, context(f.repo));
      }
      const db = new DatabaseSync(join(f.state, "pi-tai", "state.sqlite3"));
      assert.equal(
        (db.prepare("SELECT count(*) n FROM workspace WHERE id='legacy-id'").get() as any).n,
        1,
      );
      assert.equal(
        (
          db
            .prepare("SELECT count(*) n FROM migration_ledger WHERE source='workspaces_json'")
            .get() as any
        ).n,
        1,
      );
      db.close();
      const retired = (await import("node:fs/promises"))
        .readdir(legacyDir)
        .then((names) => names.find((n) => n.startsWith("workspaces.json.migrated-"))!);
      assert.equal(await readFile(join(legacyDir, await retired), "utf8"), legacy);
    } finally {
      f.restore();
    }
  });

  it("fails workspace isolation actionably for an unavailable state root without breaking shared registration", async () => {
    const f = await fixture();
    try {
      await writeFile(f.state, "not a directory");
      const h = host();
      registerAgents(h.pi as never, {
        config: { session: () => ({}) } as never,
        agentDir: join(f.home, ".pi", "agent"),
      });
      // Production still loads all shared-mode tooling and dashboard hooks; workspace failure has one remediation hint.
      await assert.rejects(
        () => callStatus(h, context(f.repo)),
        /Workspace custody unavailable|ENOTDIR/,
      );
      assert.ok(h.tools.has("subagent_spawn"));
    } finally {
      f.restore();
    }
  });
});

it("production register has negative space for the legacy registry", async () => {
  const source = await readFile(
    new URL("../../packages/pi-tai/src/core/subagents/register.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /FileWorkspaceRegistry|new\s+WorkspaceManager\s*\(/);
  assert.match(source, /new SQLiteWorkspaceManager\s*\(/);
});
