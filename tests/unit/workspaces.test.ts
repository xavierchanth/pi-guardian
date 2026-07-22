import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionCapabilityController } from "../../packages/pi-tai/src/capabilities/controller.ts";
import { JjWorkspaceService, type JjCommandRunner } from "../../packages/pi-tai/src/subagents/jj.ts";
import type { DelegationRecord, DelegationStore } from "../../packages/pi-tai/src/subagents/store.ts";
import type { WorkspacePort } from "../../packages/pi-tai/src/workspaces/domain.ts";
import { GitWorktreePort } from "../../packages/pi-tai/src/workspaces/git.ts";
import { PreferredWorkspacePort } from "../../packages/pi-tai/src/workspaces/preferred.ts";
import { registerWorkspaceCapabilities } from "../../packages/pi-tai/src/workspaces/register.ts";
import type {
  WorkspaceTransitionRecord,
  WorkspaceTransitionStore,
} from "../../packages/pi-tai/src/workspaces/store.ts";

const execFileAsync = promisify(execFile);

test("JJ relocation creates a successor workspace above the source @", async () => {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const source = "/repo";
  const target = "/repo/.jj/workspaces/focused";
  const runner: JjCommandRunner = async (cwd, args) => {
    calls.push({ cwd, args });
    const command = args.join(" ");
    if (command === "root") return "/repo\n";
    if (command.startsWith("workspace list")) return "default|source-change\n";
    if (command === "diff -r @ --summary") return "";
    if (command.includes("-r @ --no-graph") && cwd === target) return "successor-root\n";
    if (command.includes("-r @- --no-graph") && cwd === target) return "source-change\n";
    if (command.includes("-r @ --no-graph")) return "source-change\n";
    if (command.startsWith("workspace add")) return "";
    throw new Error(`Unexpected command: ${cwd}: ${command}`);
  };
  const service = new JjWorkspaceService(runner, {
    mkdir: async () => undefined,
    rm: async () => undefined,
  });
  const created = await service.createRelocationWorkspace(source, "focused");
  assert.equal(created.baseChangeId, "source-change");
  assert.equal(created.childRootChangeId, "successor-root");
  assert.deepEqual(
    calls.find((call) => call.args[0] === "workspace" && call.args[1] === "add")?.args,
    ["workspace", "add", target, "--name", "focused", "-r", "source-change"],
  );
});

test("preferred backend selects JJ before mutation and falls back to Git only when unavailable", async () => {
  const calls: string[] = [];
  const git = {
    kind: "git",
    probe: async () => ({ available: true }),
    create: async () => {
      calls.push("git-create");
      return { backend: "git", purpose: "delegation" };
    },
  } as unknown as WorkspacePort;
  const unavailableJj = {
    kind: "jj",
    probe: async () => ({ available: false, reason: "not jj" }),
  } as unknown as WorkspacePort;
  await new PreferredWorkspacePort(unavailableJj, git).create({ cwd: "/repo", name: "task", purpose: "delegation" });
  assert.deepEqual(calls, ["git-create"]);

  const failingJj = {
    kind: "jj",
    probe: async () => ({ available: true }),
    create: async () => {
      calls.push("jj-create");
      throw new Error("partial JJ failure");
    },
  } as unknown as WorkspacePort;
  await assert.rejects(
    new PreferredWorkspacePort(failingJj, git).create({ cwd: "/repo", name: "task-two", purpose: "delegation" }),
    /partial JJ failure/,
  );
  assert.deepEqual(calls, ["git-create", "jj-create"]);
});

test("Git relocation creates a managed branch and refuses to abandon dirty work", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-git-worktree-"));
  const repo = join(root, "repo");
  const managed = join(root, "managed");
  await mkdir(repo);
  await execFileAsync("git", ["init", "-q"], { cwd: repo });
  await writeFile(join(repo, "file.txt"), "base\n");
  await execFileAsync("git", ["add", "file.txt"], { cwd: repo });
  await execFileAsync("git", ["-c", "user.name=Pi Tai", "-c", "user.email=pi@example.invalid", "commit", "-qm", "base"], { cwd: repo });

  const port = new GitWorktreePort(managed);
  const workspace = await port.create({ cwd: repo, name: "focused", purpose: "relocation" });
  assert.equal(workspace.backend, "git");
  assert.equal(workspace.backend === "git" && workspace.branch, "pi-tai/relocation/focused");
  await access(workspace.path);
  assert.equal((await port.captureTip(workspace)).clean, true);

  await writeFile(join(workspace.path, "file.txt"), "dirty\n");
  assert.deepEqual(await port.abandon(workspace), { removed: false, recoveryPath: workspace.path });
  await execFileAsync("git", ["reset", "--hard", "-q"], { cwd: workspace.path });
  assert.deepEqual(await port.abandon(workspace), { removed: true });
});

test("Git delegated work preserves commits through reviewed merge and finalization", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-git-delegation-"));
  const repo = join(root, "repo");
  const managed = join(root, "managed");
  await mkdir(repo);
  await execFileAsync("git", ["init", "-q"], { cwd: repo });
  await writeFile(join(repo, "file.txt"), "base\n");
  await execFileAsync("git", ["add", "file.txt"], { cwd: repo });
  const identity = ["-c", "user.name=Pi Tai", "-c", "user.email=pi@example.invalid"];
  await execFileAsync("git", [...identity, "commit", "-qm", "base"], { cwd: repo });

  const port = new GitWorktreePort(managed);
  const workspace = await port.create({ cwd: repo, name: "child", purpose: "delegation" });
  await writeFile(join(workspace.path, "file.txt"), "child\n");
  await execFileAsync("git", ["add", "file.txt"], { cwd: workspace.path });
  await execFileAsync("git", [...identity, "commit", "-qm", "child change"], { cwd: workspace.path });
  assert.equal((await port.captureTip(workspace)).clean, true);

  assert.deepEqual(await port.integrate(workspace), { conflicted: false, conflictFiles: [] });
  await execFileAsync("git", ["config", "user.name", "Pi Tai"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "pi@example.invalid"], { cwd: repo });
  await port.finalize(workspace);
  await assert.rejects(access(workspace.path));
  const history = (await execFileAsync("git", ["log", "--oneline", "--all"], { cwd: repo })).stdout;
  assert.match(history, /child change/);
  assert.match(history, /merge delegated workspace child/);
});

test("direct JJ capability forks the session, switches cwd, and stays standalone", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-relocation-"));
  const sourceCwd = join(root, "source");
  const targetCwd = join(root, "target");
  const sessions = join(root, "sessions");
  await Promise.all([mkdir(sourceCwd), mkdir(targetCwd), mkdir(sessions)]);
  const source = SessionManager.create(sourceCwd, sessions);
  source.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "existing context" }],
    api: "openai-responses",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });

  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const tools = new Map<string, unknown>();
  const pi = {
    on() {},
    registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, options.handler);
    },
    registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  const transitions = new MemoryTransitionStore();
  const workspace = {
    kind: "jj",
    probe: async () => ({ available: true }),
    create: async () => ({
      backend: "jj",
      purpose: "relocation",
      repoRoot: root,
      sourceWorkspace: "default",
      baseChangeId: "source",
      name: "focused",
      path: targetCwd,
      rootChangeId: "successor",
    }),
  } as unknown as WorkspacePort;
  const capabilities = new SessionCapabilityController();
  registerWorkspaceCapabilities(pi, {
    capabilities,
    jj: workspace,
    transitions,
    delegations: emptyDelegations(),
  });

  let switchedFile: string | undefined;
  const notifications: string[] = [];
  const ctx = {
    cwd: sourceCwd,
    sessionManager: source,
    waitForIdle: async () => {},
    switchSession: async (path: string, options: { withSession?: (ctx: any) => Promise<void> }) => {
      switchedFile = path;
      await options.withSession?.({ ui: { notify: (message: string) => notifications.push(message) } });
      return { cancelled: false };
    },
    ui: { notify: (message: string) => notifications.push(message) },
  };
  await commands.get("cap:jj-workspaces")?.("new focused", ctx);

  assert.ok(switchedFile);
  const successor = SessionManager.open(switchedFile!);
  assert.equal(successor.getCwd(), targetCwd);
  assert.match(JSON.stringify(successor.getEntries()), /existing context/);
  assert.equal(transitions.records[0]?.state, "switched");
  assert.equal(transitions.records[0]?.successorSessionId, successor.getSessionId());
  assert.ok(tools.has("create_jj_workspace"));
});

class MemoryTransitionStore implements WorkspaceTransitionStore {
  records: WorkspaceTransitionRecord[] = [];
  async create(record: WorkspaceTransitionRecord) { this.records.push(structuredClone(record)); }
  async get(id: string) { return this.records.find((record) => record.id === id); }
  async update(id: string, update: (record: WorkspaceTransitionRecord) => WorkspaceTransitionRecord) {
    const index = this.records.findIndex((record) => record.id === id);
    if (index < 0) throw new Error("missing transition");
    const next = update(this.records[index]);
    this.records[index] = structuredClone(next);
    return next;
  }
  async list() { return this.records.map((record) => structuredClone(record)); }
}

function emptyDelegations(): DelegationStore {
  return {
    create: async () => {},
    get: async () => undefined,
    update: async () => { throw new Error("unused"); },
    list: async () => [],
    listChildren: async () => [],
  };
}
