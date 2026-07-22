import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { SessionCapabilityController } from "../../packages/pi-tai/src/capabilities/controller.ts";
import {
  DEFAULT_MODEL_PREFERENCES,
  ROLE_TOOL_NAMES,
  activeToolsForRole,
  composePiTaiInstructions,
  parseSubagentsCommand,
  type SubagentRole,
} from "../../packages/pi-tai/src/subagents/domain.ts";
import {
  FileDelegationStore,
  waitForChildren,
  type DelegationRecord,
} from "../../packages/pi-tai/src/subagents/store.ts";
import {
  JjWorkspaceService,
  type JjCommandRunner,
} from "../../packages/pi-tai/src/subagents/jj.ts";
import { registerSubagents } from "../../packages/pi-tai/src/subagents/register.ts";
import { GitWorktreePort } from "../../packages/pi-tai/src/workspaces/git.ts";
import { JjWorkspacePort } from "../../packages/pi-tai/src/workspaces/jj.ts";
import { PreferredWorkspacePort } from "../../packages/pi-tai/src/workspaces/preferred.ts";
import type { WorkspacePort } from "../../packages/pi-tai/src/workspaces/domain.ts";
import { PiChildProcessLauncher } from "../../packages/pi-tai/src/subagents/launcher.ts";
import { SubagentOrchestrator } from "../../packages/pi-tai/src/subagents/orchestrator.ts";
import type { DelegationStore } from "../../packages/pi-tai/src/subagents/store.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

const PARENT_TOOLS = [
  "spawn_child",
  "message_child",
  "wait_for_children",
  "child_status",
  "integrate_child",
  "abandon_child",
];

test("default semantic model preferences are unique thinker, worker, and mechanical choices", () => {
  assert.deepEqual(DEFAULT_MODEL_PREFERENCES.map((entry) => entry.id), [
    "thinker",
    "worker",
    "mechanical",
  ]);
  assert.equal(new Set(DEFAULT_MODEL_PREFERENCES.map((entry) => entry.id)).size, 3);
  assert.deepEqual(
    DEFAULT_MODEL_PREFERENCES.map((entry) => `${entry.model}:${entry.effort}`),
    ["gpt-5.6-sol:high", "gpt-5.6-sol:low", "gpt-5.6-luna:high"],
  );
});

test("subagent roles expose only their own tools", () => {
  const base = ["read", "bash", ...ROLE_TOOL_NAMES];
  const expected: Record<SubagentRole, string[]> = {
    standalone: ["read", "bash"],
    parent: ["read", "bash", ...PARENT_TOOLS],
    child: ["read", "bash", "report_to_parent"],
  };
  for (const role of ["standalone", "parent", "child"] as const) {
    assert.deepEqual(activeToolsForRole(base, role), expected[role]);
  }
});

test("cap:subagents command defaults to on and accepts explicit status/off", () => {
  assert.equal(parseSubagentsCommand(""), "on");
  assert.equal(parseSubagentsCommand("on"), "on");
  assert.equal(parseSubagentsCommand("status"), "status");
  assert.equal(parseSubagentsCommand("off"), "off");
  assert.equal(parseSubagentsCommand("unexpected"), undefined);
});

test("instruction composition skips empty authored files and injects factual role context", () => {
  const standalone = composePiTaiInstructions({
    basePrompt: "base",
    role: "standalone",
    systemInstructions: "",
    roleInstructions: "",
  });
  assert.equal(standalone, "base");

  const parent = composePiTaiInstructions({
    basePrompt: "base",
    role: "parent",
    systemInstructions: "Omakase",
    roleInstructions: "Parent taste",
    modelPreferences: DEFAULT_MODEL_PREFERENCES,
  });
  assert.match(parent, /Omakase/);
  assert.match(parent, /Parent taste/);
  assert.match(parent, /subagent_role="parent"/);
  assert.match(parent, /workspace_creation="spawn_child_only"/);
  assert.match(parent, /backend_selection="jj_then_git"/);
  assert.match(parent, /jj_child_base="parent_@-"/);
  assert.match(parent, /child_workspace_owner="child_exclusive"/);
  assert.match(parent, /parent_work_while_child_active="forbidden"/);
  assert.match(parent, /next_action_after_spawn="wait_for_children"/);
  assert.match(parent, /id="thinker"/);
  assert.match(parent, /gpt-5\.6-sol/);

  const child = composePiTaiInstructions({
    basePrompt: "base",
    role: "child",
    systemInstructions: "",
    roleInstructions: "",
    delegation: {
      id: "delegation",
      parentSessionId: "parent",
      backend: "jj",
      workspace: "/repo/.jj/workspaces/child",
      baseId: "base-change",
      rootId: "child-root",
    },
  });
  assert.match(child, /workspace_ownership owner="child_exclusive"/);
  assert.match(child, /repository_reads_edits_tests_and_vcs="delegated_workspace_only"/);
  assert.match(child, /parent_must_not_duplicate_or_modify="true"/);
});

test("file delegation store updates records atomically and wait snapshots direct children", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-delegations-"));
  const store = new FileDelegationStore(root);
  await store.create(record("one", "running"));
  await store.create(record("two", "running"));

  const waiting = waitForChildren(store, "parent-session", { pollIntervalMs: 5 });
  await store.update("one", (current) => ({ ...current, state: "completed" }));
  await store.update("two", (current) => ({ ...current, state: "failed" }));
  const result = await waiting;
  assert.deepEqual(result.map((entry) => entry.id).sort(), ["one", "two"]);

  const persisted = JSON.parse(await readFile(join(root, "one.json"), "utf8")) as DelegationRecord;
  assert.equal(persisted.state, "completed");
});

test("version-1 JJ delegation records migrate to tagged version-2 workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-delegation-migration-"));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "legacy.json"), JSON.stringify({
    version: 1,
    id: "legacy",
    state: "completed",
    task: "legacy task",
    modelPreferenceId: "worker",
    parentSessionId: "parent-session",
    parentWorkspace: "default",
    repoRoot: "/repo",
    baseChangeId: "base",
    childWorkspace: "legacy-child",
    childWorkspacePath: "/repo/.jj/workspaces/legacy-child",
    childRootChangeId: "root",
    report: {
      outcome: "completed",
      summary: "done",
      childTipChangeId: "tip",
      reportedAt: new Date(0).toISOString(),
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }));
  const migrated = await new FileDelegationStore(root).get("legacy");
  assert.equal(migrated?.version, 2);
  assert.deepEqual(migrated?.workspace, {
    backend: "jj",
    purpose: "delegation",
    repoRoot: "/repo",
    sourceWorkspace: "default",
    baseChangeId: "base",
    name: "legacy-child",
    path: "/repo/.jj/workspaces/legacy-child",
    rootChangeId: "root",
  });
  assert.equal(migrated?.report?.childTipId, "tip");
});

test("orchestrator persists child launch, wakes parent wait from report, and captures child tip", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-orchestrator-"));
  const store = new FileDelegationStore(root);
  const workspace = {
    kind: "jj",
    create: async ({ name }: { name: string }) => ({
      backend: "jj",
      purpose: "delegation",
      repoRoot: "/repo",
      sourceWorkspace: "default",
      baseChangeId: "base",
      name,
      path: `/repo/.jj/workspaces/${name}`,
      rootChangeId: "child-root",
    }),
    captureTip: async () => ({ id: "child-tip", clean: true }),
  } as unknown as WorkspacePort;
  const childMessages: Array<{ message: string; delivery: string }> = [];
  const launcher = {
    launch: async () => ({
      pid: process.pid,
      logPath: "/tmp/child.log",
      controlPath: "/tmp/child.fifo",
    }),
    message: async (_record: DelegationRecord, message: string, delivery: string) => {
      childMessages.push({ message, delivery });
    },
    cleanup: async () => undefined,
  };
  const orchestrator = new SubagentOrchestrator({ store, workspace, launcher });
  const spawned = await orchestrator.spawnChild({
    task: "Implement the bounded change",
    modelPreferenceId: "worker",
    parentCwd: "/repo",
    parentSessionId: "parent-session",
  });
  assert.equal(spawned.state, "running");
  assert.equal(spawned.workspace.backend, "jj");
  assert.equal(spawned.workspace.backend === "jj" && spawned.workspace.rootChangeId, "child-root");
  assert.equal(spawned.childControlPath, "/tmp/child.fifo");

  const messaged = await orchestrator.message(spawned.id, "Focus on the failing test", "steer");
  assert.deepEqual(childMessages, [{ message: "Focus on the failing test", delivery: "steer" }]);
  assert.equal(messaged.parentMessages?.[0]?.message, "Focus on the failing test");

  const waiting = orchestrator.wait("parent-session");
  const reported = await orchestrator.report(spawned.id, {
    outcome: "completed",
    summary: "done",
    validation: ["tests pass"],
  });
  assert.equal(reported.report?.childTipId, "child-tip");
  assert.deepEqual((await waiting).map((record) => record.state), ["completed"]);
});

test("subagent workspace selection falls back to Git before child launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-git-child-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  await execFileAsync("git", ["init", "-q"], { cwd: repo });
  await writeFile(join(repo, "file.txt"), "base\n");
  await execFileAsync("git", ["add", "file.txt"], { cwd: repo });
  await execFileAsync("git", ["-c", "user.name=Pi Tai", "-c", "user.email=pi@example.invalid", "commit", "-qm", "base"], { cwd: repo });
  const jjUnavailable = {
    kind: "jj",
    probe: async () => ({ available: false, reason: "not jj" }),
  } as unknown as WorkspacePort;
  const git = new GitWorktreePort(join(root, "managed"));
  const workspace = new PreferredWorkspacePort(jjUnavailable, git);
  const store = new FileDelegationStore(join(root, "delegations"));
  const launcher = {
    launch: async () => ({ pid: 999_999_999, logPath: "/tmp/child.log", controlPath: "/tmp/child.fifo" }),
    message: async () => {},
    cleanup: async () => {},
  };
  const orchestrator = new SubagentOrchestrator({ store, workspace, launcher });
  const spawned = await orchestrator.spawnChild({
    task: "Git fallback task",
    modelPreferenceId: "worker",
    parentCwd: repo,
    parentSessionId: "parent",
  });
  assert.equal(spawned.workspace.backend, "git");
  assert.equal(spawned.workspace.purpose, "delegation");
  assert.equal(spawned.workspace.backend === "git" && spawned.workspace.branch.startsWith("pi-tai/delegation/"), true);
  await git.abandon(spawned.workspace);
});

test("persistent child control channel writes RPC steering commands", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-tai-control-"));
  const storeRoot = join(stateRoot, "delegations");
  const controlDir = join(stateRoot, "control");
  const controlPath = join(controlDir, "one.fifo");
  await mkdir(controlDir);
  await execFileAsync("mkfifo", [controlPath]);
  const reader = await open(controlPath, constants.O_RDWR | constants.O_NONBLOCK);
  const launcher = new PiChildProcessLauncher({ root: storeRoot } as DelegationStore);
  const child = { ...record("one", "running"), childControlPath: controlPath };
  try {
    await launcher.message(child, "Prioritize the regression test", "followUp");
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await reader.read(buffer);
    assert.deepEqual(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8").trim()), {
      type: "prompt",
      message: "Prioritize the regression test",
      streamingBehavior: "followUp",
    });
  } finally {
    await reader.close();
    await launcher.cleanup(child);
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("subagent extension starts standalone and enables parent tools only through command", async () => {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const tools = new Map<string, any>();
  const entries: any[] = [];
  let active = ["read", ...ROLE_TOOL_NAMES];
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, options.handler);
    },
    registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
    getActiveTools: () => [...active],
    setActiveTools(next: string[]) { active = [...next]; },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
  } as unknown as ExtensionAPI;
  const orchestrator = {
    children: async () => [],
  } as unknown as SubagentOrchestrator;
  const capabilities = new SessionCapabilityController();
  capabilities.bindTools({
    getActiveTools: () => [...active],
    setActiveTools: (next) => { active = [...next]; },
  });
  capabilities.register({
    id: "jj-workspaces",
    label: "JJ Workspaces",
    description: "JJ",
    toolNames: ["create_jj_workspace"],
  });
  capabilities.register({
    id: "git-worktrees",
    label: "Git Worktrees",
    description: "Git",
    toolNames: ["create_git_worktree"],
  });
  registerSubagents(pi, {
    store: {} as DelegationStore,
    orchestrator,
    capabilities,
    workspace: {
      kind: "jj",
      probe: async () => ({ available: true }),
    } as unknown as WorkspacePort,
    loadInstructions: () => ({ system: "", parent: "", child: "" }),
  });
  const notifications: string[] = [];
  let leafEntry: unknown;
  const ctx = {
    cwd: "/repo",
    sessionManager: {
      getEntries: () => entries,
      getLeafEntry: () => leafEntry,
      getSessionId: () => "parent",
      getSessionFile: () => "/session.jsonl",
    },
    ui: { notify(message: string) { notifications.push(message); } },
  };
  await handlers.get("session_start")?.[0]({ reason: "startup" }, ctx);
  assert.deepEqual(active, ["read"]);
  assert.ok(tools.has("spawn_child"));
  assert.ok(tools.has("message_child"));
  assert.ok(tools.has("report_to_parent"));

  await commands.get("cap:subagents")?.("", ctx);
  assert.deepEqual(active, ["read", ...PARENT_TOOLS]);
  assert.equal(capabilities.isServiceEnabled("jj-workspaces"), true);
  assert.equal(capabilities.isToolExposed("jj-workspaces"), false);
  assert.equal(active.includes("create_jj_workspace"), false);
  assert.match(notifications.at(-1) ?? "", /enabled/);

  const directWorkspace = await handlers.get("tool_call")?.[0]({
    toolName: "bash",
    input: { command: "jj workspace add .jj/workspaces/task" },
  }, ctx);
  assert.match(directWorkspace.reason, /must use spawn_child/);

  await handlers.get("turn_start")?.[0]({}, ctx);
  leafEntry = {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", name: "spawn_child" }, { type: "toolCall", name: "read" }],
    },
  };
  const earlierSiblingWork = await handlers.get("tool_call")?.[0]({ toolName: "read", input: {} }, ctx);
  assert.match(earlierSiblingWork.reason, /same turn as spawn_child/);

  await handlers.get("tool_call")?.[0]({ toolName: "spawn_child", input: {} }, ctx);
  const laterSiblingWork = await handlers.get("tool_call")?.[0]({ toolName: "read", input: {} }, ctx);
  assert.match(laterSiblingWork.reason, /same turn as spawn_child/);
  leafEntry = undefined;

  const prompt = await handlers.get("before_agent_start")?.[0]({ systemPrompt: "base" }, ctx);
  assert.match(prompt.systemPrompt, /subagent_role="parent"/);

  await handlers.get("session_start")?.[0]({ reason: "fork" }, ctx);
  assert.deepEqual(active, ["read"]);
  const forkPrompt = await handlers.get("before_agent_start")?.[0]({ systemPrompt: "base" }, ctx);
  assert.doesNotMatch(forkPrompt.systemPrompt, /subagent_role=/);
});

test("JJ workspace creation anchors child root to parent @- without inspecting parent changes", async () => {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const parentRoot = "/repo";
  const childRoot = "/repo/.jj/workspaces/task-one";
  const runner: JjCommandRunner = async (cwd, args) => {
    calls.push({ cwd, args });
    const command = args.join(" ");
    if (command === "root") return `${parentRoot}\n`;
    if (command.includes("-r @ --no-graph") && cwd === childRoot) return "child-root\n";
    if (command.includes("-r @ --no-graph")) return "parent-working\n";
    if (command.includes("-r @- --no-graph")) return "base-change\n";
    if (command.startsWith("workspace list")) return "default|parent-working\n";
    if (command.startsWith("workspace add")) return "";
    throw new Error(`Unexpected jj call: ${cwd}: ${command}`);
  };
  const service = new JjWorkspaceService(runner, {
    mkdir: async () => undefined,
    rm: async () => undefined,
  });

  const created = await service.createChildWorkspace(parentRoot, "task-one");
  assert.equal(created.baseChangeId, "base-change");
  assert.equal(created.childRootChangeId, "child-root");
  assert.equal(created.parentWorkspace, "default");
  assert.equal(calls.some((call) => call.args[0] === "diff"), false);
  assert.equal(calls.some((call) => ["new", "describe", "squash", "rebase"].includes(call.args[0] ?? "")), false);
  assert.deepEqual(
    calls.find((call) => call.args[0] === "workspace" && call.args[1] === "add")?.args,
    ["workspace", "add", childRoot, "--name", "task-one", "-r", "base-change"],
  );
});

test("JJ child creation preserves empty and modified parent @ while branching both from @-", async (t) => {
  try {
    await execFileAsync("jj", ["--version"]);
  } catch {
    t.skip("jj is unavailable");
    return;
  }

  for (const parentState of ["empty", "modified"] as const) {
    await t.test(parentState, async () => {
      const root = await mkdtemp(join(tmpdir(), `pi-tai-jj-${parentState}-`));
      const repo = join(root, "repo");
      await execFileAsync("jj", ["git", "init", repo]);
      await writeFile(join(repo, "base.txt"), "base\n");
      await execFileAsync("jj", ["describe", "-m", "base"], { cwd: repo });
      await execFileAsync("jj", ["new"], { cwd: repo });
      if (parentState === "modified") await writeFile(join(repo, "parent.txt"), "parent work\n");

      const beforeChange = (await execFileAsync("jj", ["log", "-r", "@", "--no-graph", "-T", "change_id"], { cwd: repo })).stdout;
      const beforeDiff = (await execFileAsync("jj", ["diff", "-r", "@", "--git"], { cwd: repo })).stdout;
      const expectedBase = (await execFileAsync("jj", ["log", "-r", "@-", "--no-graph", "-T", "change_id"], { cwd: repo })).stdout;

      try {
        const created = await new JjWorkspaceService().createChildWorkspace(repo, `child-${parentState}`);
        const afterChange = (await execFileAsync("jj", ["log", "-r", "@", "--no-graph", "-T", "change_id"], { cwd: repo })).stdout;
        const afterDiff = (await execFileAsync("jj", ["diff", "-r", "@", "--git"], { cwd: repo })).stdout;
        const actualBase = (await execFileAsync("jj", ["log", "-r", "@-", "--no-graph", "-T", "change_id"], { cwd: created.childWorkspacePath })).stdout;

        assert.equal(created.baseChangeId, expectedBase.trim());
        assert.equal(actualBase, expectedBase);
        assert.equal(afterChange, beforeChange);
        assert.equal(afterDiff, beforeDiff);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("JJ integration moves the recorded root and all descendants before parent @", async () => {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const runner: JjCommandRunner = async (cwd, args) => {
    calls.push({ cwd, args });
    if (args[0] === "workspace" && args[1] === "update-stale") return "";
    if (args[0] === "log") return "child-root\n";
    if (args[0] === "rebase") return "";
    if (args[0] === "resolve") return "";
    throw new Error(`Unexpected jj call: ${cwd}: ${args.join(" ")}`);
  };
  const service = new JjWorkspaceService(runner, {
    mkdir: async () => undefined,
    rm: async () => undefined,
  });
  const port = new JjWorkspacePort(service);

  const result = await port.integrate({
    backend: "jj",
    purpose: "delegation",
    repoRoot: "/repo",
    sourceWorkspace: "default",
    baseChangeId: "base",
    name: "task-one",
    path: "/repo/.jj/workspaces/task-one",
    rootChangeId: "child-root",
  });
  assert.equal(result.conflicted, false);
  assert.deepEqual(calls[2], {
    cwd: "/repo",
    args: ["rebase", "-s", "child-root", "-B", "default@"],
  });
});

function record(id: string, state: DelegationRecord["state"]): DelegationRecord {
  return {
    version: 2,
    id,
    state,
    task: `task ${id}`,
    modelPreferenceId: "worker",
    parentSessionId: "parent-session",
    workspace: {
      backend: "jj",
      purpose: "delegation",
      repoRoot: "/repo",
      sourceWorkspace: "default",
      baseChangeId: "base",
      name: `child-${id}`,
      path: `/repo/.jj/workspaces/child-${id}`,
      rootChangeId: `root-${id}`,
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}
