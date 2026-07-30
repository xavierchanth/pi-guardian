import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { BackendRegistry } from "../../packages/pi-tai/src/agents/backend.ts";
import { StubBackend } from "../../packages/pi-tai/src/agents/backends/stub.ts";
import { IsolatedSubagents } from "../../packages/pi-tai/src/agents/isolated.ts";
import { SubagentManager } from "../../packages/pi-tai/src/agents/manager.ts";
import type { SubagentSnapshot } from "../../packages/pi-tai/src/agents/domain.ts";
import {
  InMemoryWorkspaceRegistry,
  JjCli,
  WorkspaceManager,
} from "../../packages/pi-tai/src/isolation/index.ts";
import { JjProcessExecutor } from "../../packages/pi-tai/src/jj/executor.ts";

const run = promisify(execFile);
const roots: string[] = [];

async function jj(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("jj", ["--no-pager", "--color=never", ...args], { cwd });
  return stdout;
}

/** A backend whose children write a described change into their own workspace. */
function writingBackend(file: string, contents: string): StubBackend {
  const backend = new StubBackend();
  const original = backend.spawn.bind(backend);
  backend.spawn = async (task) => {
    await writeFile(join(task.cwd, file), contents);
    await jj(task.cwd, "describe", "--message", `agent: add ${file}`);
    await jj(task.cwd, "new");
    return original(task);
  };
  return backend;
}

async function harness(backend: StubBackend) {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-isolated-"));
  roots.push(root);
  const source = join(root, "repo");
  await run("mkdir", ["-p", source]);
  await jj(source, "git", "init");
  await writeFile(join(source, "base.txt"), "base\n");
  await jj(source, "describe", "--message", "base commit");
  await jj(source, "new");

  const workspaces = new WorkspaceManager({
    jj: new JjCli(new JjProcessExecutor()),
    registry: new InMemoryWorkspaceRegistry(),
    sourcePath: source,
    workspaceRoot: join(root, "workspaces"),
  });
  const settled: SubagentSnapshot[] = [];
  let isolated!: IsolatedSubagents;
  const agents = new SubagentManager({
    registry: new BackendRegistry([backend]),
    onSettled: async (snapshot) => {
      settled.push(snapshot);
      await isolated.reclaimIfEmpty(snapshot);
    },
  });
  isolated = new IsolatedSubagents({ agents, workspaces, sourcePath: source });
  return { source, workspaces, agents, isolated, settled };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    backend: "pi" as const,
    prompt: "implement the feature",
    systemPrompt: "you are a worker",
    title: "worker",
    isolation: "workspace" as const,
    ...overrides,
  };
}

/**
 * Waits for the manager's post-settle hook to finish. The hook runs jj
 * commands, so a fixed sleep would be flaky; poll the observable outcome.
 */
async function settleQueue(check: () => Promise<boolean> = async () => true): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (await check()) return;
  }
  throw new Error("Timed out waiting for the settle hook.");
}

describe("isolated subagents", () => {
  before(async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "pi-tai-jjconfig-"));
    roots.push(configRoot);
    const configFile = join(configRoot, "config.toml");
    await writeFile(configFile, '[user]\nname = "Test"\nemail = "test@example.com"\n');
    process.env.JJ_CONFIG = configFile;
  });

  after(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });

  it("runs an isolated child inside its own workspace", async () => {
    const backend = new StubBackend();
    const { isolated, workspaces } = await harness(backend);

    const snapshot = await isolated.spawn(request());

    const workspaceId = isolated.workspaceFor(snapshot.id);
    assert.ok(workspaceId, "the subagent owns a workspace");
    const record = await workspaces.get(workspaceId!);
    assert.equal(backend.spawned[0]?.cwd, record?.path, "the child's cwd is its workspace");
  });

  it("runs a shared child in the user's working copy", async () => {
    const backend = new StubBackend();
    const { isolated, source } = await harness(backend);

    const snapshot = await isolated.spawn(request({ isolation: "shared" }));

    assert.equal(backend.spawned[0]?.cwd, source);
    assert.equal(isolated.workspaceFor(snapshot.id), undefined);
  });

  it("does not leak a workspace when the spawn itself fails", async () => {
    const backend = new StubBackend();
    backend.spawn = async () => {
      throw new Error("model provider is down");
    };
    const { isolated, workspaces, source } = await harness(backend);

    await assert.rejects(isolated.spawn(request()), /model provider is down/);

    assert.deepEqual(await workspaces.list(), [], "the workspace record is gone");
    assert.ok(
      !(await jj(source, "workspace", "list")).includes("pitai-"),
      "the jj attachment is gone",
    );
  });

  it("reclaims the workspace of a child that produced nothing", async () => {
    const { isolated, agents, workspaces } = await harness(new StubBackend());

    const snapshot = await isolated.spawn(request());
    await agents.wait([snapshot.id]);
    await settleQueue(async () => (await workspaces.list()).length === 0);

    assert.deepEqual(await workspaces.list(), [], "an empty workspace is reclaimed automatically");
    assert.equal(isolated.workspaceFor(snapshot.id), undefined);
  });

  it("keeps the workspace of a child that produced work", async () => {
    const { isolated, agents, workspaces } = await harness(
      writingBackend("feature.txt", "agent output\n"),
    );

    const snapshot = await isolated.spawn(request());
    await agents.wait([snapshot.id]);
    await settleQueue();

    assert.equal(
      (await workspaces.list()).length,
      1,
      "real work is never discarded by the settle hook",
    );
    assert.ok(isolated.workspaceFor(snapshot.id));
  });

  it("keeps a failed child's work for inspection rather than discarding it", async () => {
    const { isolated, agents, workspaces } = await harness(
      writingBackend("partial.txt", "half done\n"),
    );

    const snapshot = await isolated.spawn(request({ prompt: "FAIL: ran out of budget" }));
    const [settled] = (await agents.wait([snapshot.id])).settled;
    await settleQueue();

    assert.equal(settled?.status, "error");
    assert.equal(
      (await workspaces.list()).length,
      1,
      "a failed child's partial work survives for review",
    );
  });

  it("merges a settled child's work into the source graph", async () => {
    const { isolated, agents, source, workspaces } = await harness(
      writingBackend("feature.txt", "agent output\n"),
    );

    const snapshot = await isolated.spawn(request());
    await agents.wait([snapshot.id]);
    await settleQueue();
    const result = await isolated.merge(snapshot.id);

    assert.equal(result.kind, "merged");
    assert.equal(await readFile(join(source, "feature.txt"), "utf8"), "agent output\n");
    assert.deepEqual(await workspaces.list(), []);
    assert.equal(isolated.workspaceFor(snapshot.id), undefined);
  });

  it("refuses to merge a child that is still running", async () => {
    const { isolated } = await harness(new StubBackend());

    const snapshot = await isolated.spawn(request({ prompt: "HANG: still working" }));
    const result = await isolated.merge(snapshot.id);

    assert.equal(result.kind, "blocked");
    assert.match(result.kind === "blocked" ? result.reason : "", /still running/);
  });

  it("discards a child's work on request", async () => {
    const { isolated, agents, source, workspaces } = await harness(
      writingBackend("scratch.txt", "throwaway\n"),
    );

    const snapshot = await isolated.spawn(request());
    await agents.wait([snapshot.id]);
    await settleQueue();
    await isolated.discard(snapshot.id);

    assert.deepEqual(await workspaces.list(), []);
    await assert.rejects(readFile(join(source, "scratch.txt"), "utf8"));
  });

  it("protects a running child's workspace from the startup sweep", async () => {
    const { isolated, workspaces } = await harness(new StubBackend());

    const snapshot = await isolated.spawn(request({ prompt: "HANG: still working" }));
    const swept = await workspaces.sweep(isolated.activeOwners());

    assert.deepEqual(isolated.activeOwners(), [snapshot.id]);
    assert.equal(swept[0]?.disposition, "kept");
    assert.equal((await workspaces.list()).length, 1);
  });
});
