import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
import { SubagentOrchestrator } from "../../packages/pi-tai/src/subagents/orchestrator.ts";
import type { DelegationStore } from "../../packages/pi-tai/src/subagents/store.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PARENT_TOOLS = [
  "spawn_child",
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

test("sub-agents command defaults to on and accepts explicit status/off", () => {
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
  assert.match(parent, /id="thinker"/);
  assert.match(parent, /gpt-5\.6-sol/);
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

test("orchestrator persists child launch, wakes parent wait from report, and captures child tip", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-orchestrator-"));
  const store = new FileDelegationStore(root);
  const jj = {
    createChildWorkspace: async (_cwd: string, childWorkspace: string) => ({
      repoRoot: "/repo",
      parentWorkspace: "default",
      baseChangeId: "base",
      childWorkspace,
      childWorkspacePath: `/repo/.jj/workspaces/${childWorkspace}`,
      childRootChangeId: "child-root",
    }),
    currentChangeId: async () => "child-tip",
  } as unknown as JjWorkspaceService;
  const launcher = {
    launch: async () => ({ pid: process.pid, logPath: "/tmp/child.log" }),
  };
  const orchestrator = new SubagentOrchestrator({ store, jj, launcher });
  const spawned = await orchestrator.spawnChild({
    task: "Implement the bounded change",
    modelPreferenceId: "worker",
    parentCwd: "/repo",
    parentSessionId: "parent-session",
  });
  assert.equal(spawned.state, "running");
  assert.equal(spawned.childRootChangeId, "child-root");

  const waiting = orchestrator.wait("parent-session");
  const reported = await orchestrator.report(spawned.id, {
    outcome: "completed",
    summary: "done",
    validation: ["tests pass"],
  });
  assert.equal(reported.report?.childTipChangeId, "child-tip");
  assert.deepEqual((await waiting).map((record) => record.state), ["completed"]);
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
  registerSubagents(pi, {
    store: {} as DelegationStore,
    orchestrator,
    loadInstructions: () => ({ system: "", parent: "", child: "" }),
  });
  const notifications: string[] = [];
  const ctx = {
    cwd: "/repo",
    sessionManager: {
      getEntries: () => entries,
      getSessionId: () => "parent",
      getSessionFile: () => "/session.jsonl",
    },
    ui: { notify(message: string) { notifications.push(message); } },
  };
  await handlers.get("session_start")?.[0]({ reason: "startup" }, ctx);
  assert.deepEqual(active, ["read"]);
  assert.ok(tools.has("spawn_child"));
  assert.ok(tools.has("report_to_parent"));

  await commands.get("sub-agents")?.("", ctx);
  assert.deepEqual(active, ["read", ...PARENT_TOOLS]);
  assert.match(notifications.at(-1) ?? "", /enabled/);

  const prompt = await handlers.get("before_agent_start")?.[0]({ systemPrompt: "base" }, ctx);
  assert.match(prompt.systemPrompt, /subagent_role="parent"/);

  await handlers.get("session_start")?.[0]({ reason: "fork" }, ctx);
  assert.deepEqual(active, ["read"]);
  const forkPrompt = await handlers.get("before_agent_start")?.[0]({ systemPrompt: "base" }, ctx);
  assert.doesNotMatch(forkPrompt.systemPrompt, /subagent_role=/);
});

test("JJ workspace creation anchors child root to the parent @- change", async () => {
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
    if (command === "diff -r @ --summary") return "";
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
  assert.deepEqual(
    calls.find((call) => call.args[0] === "diff")?.args,
    ["diff", "-r", "@", "--summary"],
  );
  assert.deepEqual(
    calls.find((call) => call.args[0] === "workspace" && call.args[1] === "add")?.args,
    ["workspace", "add", childRoot, "--name", "task-one", "-r", "base-change"],
  );
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

  const result = await service.integrateChildWorkspace({
    repoRoot: "/repo",
    parentWorkspace: "default",
    childWorkspace: "task-one",
    childWorkspacePath: "/repo/.jj/workspaces/task-one",
    childRootChangeId: "child-root",
  });
  assert.equal(result.conflicted, false);
  assert.deepEqual(calls[2], {
    cwd: "/repo",
    args: ["rebase", "-s", "child-root", "-B", "default@"],
  });
});

function record(id: string, state: DelegationRecord["state"]): DelegationRecord {
  return {
    version: 1,
    id,
    state,
    task: `task ${id}`,
    modelPreferenceId: "worker",
    parentSessionId: "parent-session",
    parentWorkspace: "default",
    repoRoot: "/repo",
    baseChangeId: "base",
    childWorkspace: `child-${id}`,
    childWorkspacePath: `/repo/.jj/workspaces/child-${id}`,
    childRootChangeId: `root-${id}`,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}
