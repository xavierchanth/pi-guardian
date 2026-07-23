import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionCapabilityController } from "../../packages/pi-tai/src/capabilities/controller.ts";
import type { AgentCatalog, AgentDefinition } from "../../packages/pi-tai/src/subagents/agents.ts";
import {
  PARENT_TOOL_NAMES,
  activeToolsForMode,
  composePiTaiInstructions,
  parseSubagentsCommand,
} from "../../packages/pi-tai/src/subagents/domain.ts";
import {
  PiChildProcessLauncher,
  managedChildRuntimePaths,
} from "../../packages/pi-tai/src/subagents/launcher.ts";
import { SubagentOrchestrator } from "../../packages/pi-tai/src/subagents/orchestrator.ts";
import { registerSubagents } from "../../packages/pi-tai/src/subagents/register.ts";
import {
  FileDelegationStore,
  waitForChildren,
  type DelegationRecord,
  type DelegationStore,
} from "../../packages/pi-tai/src/subagents/store.ts";
import { normalizeTaskPacket, renderTaskPacket } from "../../packages/pi-tai/src/subagents/task.ts";
import type { WorkspacePort } from "../../packages/pi-tai/src/workspaces/domain.ts";
import {
  delegationDepth,
  delegationTree,
  delegationTreePrefix,
  formatChildDetail,
  intrinsicUsage,
  latestAssistantLine,
  treeUsage,
} from "../../packages/pi-tai/src/subagents/ui.ts";

const execFileAsync = promisify(execFile);
const TOOL_NAMES = [
  "read", "write", "edit", "grep", "find", "ls", "bash", "update_plan",
  ...PARENT_TOOL_NAMES, "report_to_parent", "ask_parent",
];

test("subagent mode tools are exact and unified command parsing remains stable", () => {
  assert.deepEqual(parseSubagentsCommand(""), { action: "toggle" });
  assert.equal(parseSubagentsCommand("status"), undefined);
  assert.deepEqual(parseSubagentsCommand("off"), { action: "off" });
  assert.deepEqual(parseSubagentsCommand("force-off"), { action: "force-off" });
  assert.deepEqual(parseSubagentsCommand("list"), { action: "list" });
  assert.equal(parseSubagentsCommand("list child-1"), undefined);
  assert.deepEqual(parseSubagentsCommand("inspect child-1"), { action: "inspect", delegationId: "child-1" });
  assert.equal(parseSubagentsCommand("bad"), undefined);
  assert.deepEqual(activeToolsForMode(["read", ...PARENT_TOOL_NAMES], "standalone"), ["read"]);
  assert.deepEqual(activeToolsForMode(["read"], "root", ["read", "subagent"]), ["read", "subagent"]);
});

test("instruction composition describes sparse shared-cwd delegation without workspace policy", () => {
  const prompt = composePiTaiInstructions({
    basePrompt: "base",
    mode: "root",
    agentName: "thinker",
    systemInstructions: "system",
    roleInstructions: "think carefully",
    availableChildren: [{ name: "worker", description: "implements" }],
  });
  assert.match(prompt, /agent="thinker"/);
  assert.match(prompt, /conversation_history="none"/);
  assert.match(prompt, /cwd="shared"/);
  assert.match(prompt, /allowed_child name="worker"/);
  assert.doesNotMatch(prompt, /workspace_creation|jj_then_git|child_workspace/);
});

test("structured task packets normalize defaults and render deterministic sections", () => {
  const packet = normalizeTaskPacket({
    objective: " Fix auth ",
    context: ["Users are logged out"],
    resources: [{ type: "file", value: "src/auth.ts", reason: "entry point" }],
    constraints: ["No API change"],
    acceptanceCriteria: ["Tests pass"],
    expectedOutput: "Implement and summarize",
  }, "ask-parent");
  assert.equal(packet.uncertaintyHandling, "ask-parent");
  assert.equal(renderTaskPacket(packet), [
    "OBJECTIVE\n- Fix auth",
    "CONTEXT\n- Users are logged out",
    "RESOURCES\n- [file] src/auth.ts — entry point",
    "CONSTRAINTS\n- No API change",
    "ACCEPTANCE CRITERIA\n- Tests pass",
    "EXPECTED OUTPUT\n- Implement and summarize",
    "UNCERTAINTY HANDLING\n- For material ambiguity, call ask_parent and wait for a correlated response before continuing.",
  ].join("\n\n"));
});

test("legacy workspace records migrate to v3 recovery metadata without workspace actions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-delegation-migration-"));
  await writeFile(join(root, "legacy.json"), JSON.stringify({
    version: 2,
    id: "legacy",
    state: "completed",
    task: "legacy task",
    modelPreferenceId: "worker",
    parentSessionId: "parent",
    workspace: {
      backend: "jj",
      purpose: "delegation",
      repoRoot: "/repo",
      sourceWorkspace: "default",
      baseChangeId: "base",
      name: "legacy-child",
      path: "/repo/.jj/workspaces/legacy-child",
      rootChangeId: "root",
    },
    report: { outcome: "completed", summary: "done", reportedAt: new Date(0).toISOString() },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }));
  const migrated = await new FileDelegationStore(root).get("legacy");
  assert.equal(migrated?.version, 3);
  assert.equal(migrated?.cwd, "/repo/.jj/workspaces/legacy-child");
  assert.equal(migrated?.legacyWorkspace?.backend, "jj");
  assert.equal(migrated?.execution.phase, "completed");
});

test("orchestrator launches in the parent cwd and enforces the caller child allowlist", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-orchestrator-"));
  const store = new FileDelegationStore(root);
  const launches: DelegationRecord[] = [];
  const launcher = {
    launch: async (record: DelegationRecord) => {
      launches.push(record);
      return { pid: process.pid, logPath: "/tmp/child.log", controlPath: "/tmp/child.fifo", promptPath: "/tmp/child.md" };
    },
    message: async () => undefined,
    cleanup: async () => undefined,
  };
  const orchestrator = new SubagentOrchestrator({ store, launcher });
  const worker = agent("worker", ["scout", "researcher"], true);
  const scout = agent("scout", [], false);
  const record = await orchestrator.spawnChild({
    task: { objective: "Inspect auth" },
    agent: scout,
    caller: worker,
    parentCwd: "/repo",
    parentSessionId: "parent",
  });
  assert.equal(record.cwd, "/repo");
  assert.equal(record.agent.name, "scout");
  assert.equal(record.execution.phase, "running");
  assert.equal(launches[0]?.legacyWorkspace, undefined);
  await assert.rejects(
    orchestrator.spawnChild({
      task: { objective: "Spawn worker" },
      agent: worker,
      caller: worker,
      parentCwd: "/repo",
      parentSessionId: "parent",
    }),
    /cannot create/,
  );
});

test("workspace integration is explicit and includes deterministic cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-planner-workspace-"));
  const store = new FileDelegationStore(root);
  const orchestrator = new SubagentOrchestrator({
    store,
    launcher: {
      launch: async () => ({ pid: process.pid, logPath: "log", controlPath: "fifo", promptPath: "prompt" }),
      message: async () => undefined,
      cleanup: async () => undefined,
    },
  });
  const thinker = {
    ...agent("thinker", ["planner"], true),
    root: true,
    tools: ["read", "subagent", "workspace_subagent"],
  };
  const planner = agent("planner", ["worker", "scout", "researcher"], true);
  const attachment = {
    backend: "jj" as const,
    purpose: "delegation" as const,
    repoRoot: "/repo",
    sourceWorkspace: "default",
    sourcePath: "/repo",
    baseChangeId: "base",
    name: "planned",
    path: "/repo/.jj/workspaces/planned",
    rootChangeId: "root",
  };
  const child = await orchestrator.spawnChild({
    task: { objective: "Plan the subsystem" },
    agent: planner,
    caller: thinker,
    parentCwd: attachment.path,
    parentSessionId: "parent",
    workspace: attachment,
  });
  await orchestrator.report(child.id, { outcome: "completed", summary: "done" });

  const calls: string[] = [];
  const workspace = {
    kind: "jj",
    captureTip: async () => { calls.push("tip"); return { id: "tip" }; },
    integrate: async () => {
      calls.push("integrate");
      return { conflicted: false, conflictFiles: [], integratedChangeIds: ["change"], undescribedChangeIds: ["change"], removedEmptyChangeIds: ["empty"], sourceChangeId: "source", workspaceRemoved: true };
    },
    describe: async () => { calls.push("describe"); return []; },
  } as unknown as WorkspacePort;
  const integrated = await orchestrator.integrateWorkspace(child.id, workspace);
  assert.equal(integrated.workspace?.phase, "integrated");
  const described = await orchestrator.describeWorkspaceChanges(child.id, workspace, [{ changeId: "change", description: "feat: implement change" }]);
  assert.deepEqual(described.workspace?.phase === "integrated" ? described.workspace.result.undescribedChangeIds : [], []);
  assert.deepEqual(calls, ["tip", "integrate", "describe"]);
});

test("workspace integration failure enters a non-retryable attention state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-planner-workspace-stop-"));
  const store = new FileDelegationStore(root);
  const orchestrator = new SubagentOrchestrator({
    store,
    launcher: {
      launch: async () => ({ pid: process.pid, logPath: "log", controlPath: "fifo", promptPath: "prompt" }),
      message: async () => undefined,
      cleanup: async () => undefined,
    },
  });
  const thinker = {
    ...agent("thinker", ["planner"], true),
    root: true,
    tools: ["read", "subagent", "workspace_subagent"],
  };
  const planner = agent("planner", ["worker"], true);
  const attachment = {
    backend: "jj" as const,
    purpose: "delegation" as const,
    repoRoot: "/repo",
    sourceWorkspace: "default",
    sourcePath: "/repo",
    baseChangeId: "base",
    name: "planned",
    path: "/repo/.jj/workspaces/planned",
    rootChangeId: "root",
  };
  const child = await orchestrator.spawnChild({
    task: { objective: "Plan the subsystem" },
    agent: planner,
    caller: thinker,
    parentCwd: attachment.path,
    parentSessionId: "parent",
    workspace: attachment,
  });
  await orchestrator.report(child.id, { outcome: "completed", summary: "done" });
  const workspace = {
    kind: "jj",
    captureTip: async () => ({ id: "tip" }),
    integrate: async () => { throw new Error("unexpected graph"); },
  } as unknown as WorkspacePort;

  await assert.rejects(orchestrator.integrateWorkspace(child.id, workspace), /ask the user to intervene/);
  assert.equal((await store.get(child.id))?.workspace?.phase, "attention_required");
  await assert.rejects(orchestrator.integrateWorkspace(child.id, workspace), /requires user attention/);
});

test("wait next consumes one completion while status and later waits preserve the rest", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-wait-"));
  const store = new FileDelegationStore(root);
  await store.create(record("one", "completed"));
  await store.create(record("two", "completed"));
  const first = await waitForChildren(store, "parent", { pollIntervalMs: 1 });
  assert.equal(first.length, 1);
  const second = await waitForChildren(store, "parent", { pollIntervalMs: 1 });
  assert.equal(second.length, 1);
  assert.notEqual(first[0]?.id, second[0]?.id);
});

test("wait allows a bounded grace period for a concurrently spawned child", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-wait-grace-"));
  const store = new FileDelegationStore(root);
  const waiting = waitForChildren(store, "parent", {
    pollIntervalMs: 2,
    initialGraceMs: 100,
  });
  setTimeout(() => void store.create(record("late", "completed")), 10);
  const records = await waiting;
  assert.equal(records[0]?.id, "late");
});

test("recursive status collection waits for every descendant and returns non-terminal reports", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-status-"));
  const store = new FileDelegationStore(root);
  let orchestrator: SubagentOrchestrator;
  const messaged: string[] = [];
  orchestrator = new SubagentOrchestrator({
    store,
    launcher: {
      launch: async () => ({ pid: process.pid, logPath: "log", controlPath: "fifo", promptPath: "prompt" }),
      message: async (child, message) => {
        messaged.push(child.id);
        const requestId = message.match(/Status request ([^.]+)/)?.[1] ?? "";
        setTimeout(() => void orchestrator.reportStatus(child.id, { requestId, summary: `working ${child.id}` }), 1);
      },
      cleanup: async () => undefined,
    },
  });
  await store.create(record("direct-status", "running", process.pid));
  await store.create({ ...record("nested-status", "running", process.pid), parentSessionId: "child-session", parentDelegationId: "direct-status" });
  const result = await orchestrator.collectStatus("parent", 100);
  assert.deepEqual(messaged.sort(), ["direct-status", "nested-status"]);
  assert.deepEqual(result.timedOutIds, []);
  assert.equal(result.records.every((child) => child.execution.phase === "running"), true);
  assert.equal(result.records.every((child) => child.statusReports?.some((report) => report.requestId === result.requestId)), true);
});

test("recursive status collection times out partially without resolving children", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-status-timeout-"));
  const store = new FileDelegationStore(root);
  await store.create(record("silent", "running", process.pid));
  const orchestrator = new SubagentOrchestrator({ store, launcher: {
    launch: async () => ({ pid: process.pid, logPath: "log", controlPath: "fifo", promptPath: "prompt" }),
    message: async () => undefined,
    cleanup: async () => undefined,
  } });
  const result = await orchestrator.collectStatus("parent", 5);
  assert.deepEqual(result.timedOutIds, ["silent"]);
  assert.equal((await store.get("silent"))?.execution.phase, "running");
});

test("questions wake waiters and require a correlated parent response", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-question-"));
  const store = new FileDelegationStore(root);
  const sent: string[] = [];
  const orchestrator = new SubagentOrchestrator({
    store,
    launcher: {
      launch: async () => ({ pid: process.pid, logPath: "log", controlPath: "fifo", promptPath: "prompt" }),
      message: async (_record, message) => { sent.push(message); },
      cleanup: async () => undefined,
    },
  });
  await store.create(record("question", "running", process.pid));
  const waiting = waitForChildren(store, "parent", { pollIntervalMs: 1 });
  const asked = await orchestrator.askParent("question", {
    question: "Which API?",
    options: ["v1", "v2"],
    recommendation: "v2",
  });
  assert.equal((await waiting)[0]?.execution.phase, "awaiting_parent");
  const questionId = asked.execution.phase === "awaiting_parent" ? asked.execution.question.id : "";
  await assert.rejects(orchestrator.respond("question", "stale", "v2"), /Stale/);
  const resumed = await orchestrator.respond("question", questionId, "v2");
  assert.equal(resumed.execution.phase, "running");
  assert.match(sent[0] ?? "", /Parent response/);
});

test("deterministic settlement completes only after descendants resolve", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-settlement-"));
  const store = new FileDelegationStore(root);
  const orchestrator = new SubagentOrchestrator({ store, launcher: {
    launch: async () => ({ pid: process.pid, logPath: "log", controlPath: "fifo", promptPath: "prompt" }),
    message: async () => undefined, cleanup: async () => undefined,
  } });
  await store.create(record("parent-child", "running", process.pid));
  await store.create({ ...record("nested", "running", process.pid), parentSessionId: "child-session", parentDelegationId: "parent-child" });
  assert.equal((await orchestrator.settle("parent-child", "finished")).execution.phase, "running");
  await orchestrator.report("nested", { outcome: "completed", summary: "nested done" });
  await waitForChildren(store, "child-session", { pollIntervalMs: 1 });
  const settled = await orchestrator.settle("parent-child", "finished");
  assert.equal(settled.execution.phase, "completed");
  assert.equal(settled.execution.phase === "completed" ? settled.execution.report.summary : "", "finished");
});

test("force abandon terminates the full nested delegation tree but not unrelated children", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-force-abandon-"));
  const store = new FileDelegationStore(root);
  const cleaned: string[] = [];
  const orchestrator = new SubagentOrchestrator({
    store,
    launcher: {
      launch: async () => ({ pid: 999_999, logPath: "log", controlPath: "fifo", promptPath: "prompt" }),
      message: async () => undefined,
      cleanup: async (child) => { cleaned.push(child.id); },
    },
  });
  await store.create(record("direct", "running"));
  await store.create({
    ...record("nested", "running"),
    parentSessionId: "child-session",
    parentDelegationId: "direct",
  });
  await store.create({ ...record("unrelated", "running"), parentSessionId: "other" });
  const abandoned = await orchestrator.forceAbandonChildren("parent");
  assert.deepEqual(abandoned.map((child) => child.id), ["nested", "direct"]);
  assert.deepEqual(cleaned, ["nested", "direct"]);
  assert.equal((await store.get("unrelated"))?.execution.phase, "running");
});

test("abandonment recursively cleans managed runtime artifacts after preserving intrinsic tree usage", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-tai-abandon-cleanup-"));
  const storeRoot = join(stateRoot, "custom", "delegations");
  const store = new FileDelegationStore(storeRoot);
  const launcher = new PiChildProcessLauncher(store);
  const orchestrator = new SubagentOrchestrator({ store, launcher });
  const usage = (input: number, output: number, cacheRead: number, cost: number) => ({
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  });
  const directPaths = managedChildRuntimePaths(storeRoot, "direct");
  const nestedPaths = managedChildRuntimePaths(storeRoot, "nested");
  const unrelatedPaths = managedChildRuntimePaths(storeRoot, "unrelated");
  for (const path of [...Object.values(directPaths), ...Object.values(nestedPaths), ...Object.values(unrelatedPaths)]) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, path.endsWith(".jsonl") ? "" : "runtime\n");
  }
  await writeFile(directPaths.logPath, `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], usage: usage(10, 2, 3, .01) } })}\n`);
  await writeFile(nestedPaths.logPath, `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], usage: usage(20, 4, 5, .02) } })}\n`);
  const sessionFile = join(stateRoot, "custom", "sessions", "durable-session.jsonl");
  const outside = join(stateRoot, "outside.fifo");
  await mkdir(join(sessionFile, ".."), { recursive: true });
  await writeFile(sessionFile, "session metadata\n");
  await writeFile(outside, "unrelated\n");
  await store.create({
    ...record("direct", "running"),
    childLogPath: directPaths.logPath,
    childControlPath: directPaths.controlPath,
    childPromptPath: directPaths.promptPath,
    childSessionFile: sessionFile,
  });
  await store.create({
    ...record("nested", "running"),
    parentSessionId: "child-session",
    parentDelegationId: "direct",
    childLogPath: nestedPaths.logPath,
    childControlPath: outside,
    childPromptPath: nestedPaths.promptPath,
  });
  await store.create({
    ...record("unrelated", "running"),
    parentSessionId: "other",
    childLogPath: unrelatedPaths.logPath,
    childControlPath: unrelatedPaths.controlPath,
    childPromptPath: unrelatedPaths.promptPath,
  });

  const abandoned = await orchestrator.forceAbandonChildren("parent");
  assert.deepEqual(abandoned.map((child) => child.id), ["nested", "direct"]);
  for (const path of [...Object.values(directPaths), ...Object.values(nestedPaths)]) {
    await assert.rejects(readFile(path), { code: "ENOENT" });
  }
  assert.equal(await readFile(outside, "utf8"), "unrelated\n");
  assert.equal(await readFile(sessionFile, "utf8"), "session metadata\n");
  assert.equal(await readFile(unrelatedPaths.logPath, "utf8"), "");

  const direct = await store.get("direct");
  const nested = await store.get("nested");
  assert.equal(direct?.execution.phase, "abandoned");
  assert.equal(nested?.execution.phase, "abandoned");
  assert.equal(direct?.intrinsicUsage?.input, 10);
  assert.equal(nested?.intrinsicUsage?.input, 20);
  const collected = await waitForChildren(store, "parent", { pollIntervalMs: 1 });
  assert.equal(collected[0]?.id, "direct");
  const attributedUsage = await treeUsage(collected[0]!, await store.list());
  assert.equal(attributedUsage.input, 30);
  assert.equal(attributedUsage.cacheRead, 8);
  assert.equal(attributedUsage.cost.total, .03);
  await orchestrator.attributeUsage("direct");
  assert.equal((await waitForChildren(store, "parent", { pollIntervalMs: 1 })).length, 0);
  assert.match(await readFile(join(storeRoot, "direct.json"), "utf8"), /"intrinsicUsage"/);
  assert.match(await readFile(join(storeRoot, "nested.json"), "utf8"), /"intrinsicUsage"/);

  await orchestrator.abandon("direct");
  const repeated = await store.get("direct");
  assert.equal((await treeUsage(repeated!, [repeated!, (await store.get("nested"))!])).input, 30);
});

test("managed cleanup refuses symlink escapes even when record paths look expected", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "pi-tai-abandon-symlink-"));
  const storeRoot = join(stateRoot, "delegations");
  const outside = await mkdtemp(join(tmpdir(), "pi-tai-abandon-outside-"));
  await mkdir(storeRoot);
  await symlink(outside, join(stateRoot, "logs"));
  await mkdir(join(stateRoot, "control"));
  await mkdir(join(stateRoot, "prompts"));
  const paths = managedChildRuntimePaths(storeRoot, "escaped");
  await writeFile(paths.logPath, `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 99 } } })}\n`);
  await writeFile(paths.errorPath, "private\n");
  const store = new FileDelegationStore(storeRoot);
  await store.create({ ...record("escaped", "running"), childLogPath: paths.logPath });
  const orchestrator = new SubagentOrchestrator({ store, launcher: new PiChildProcessLauncher(store) });

  await orchestrator.abandon("escaped");
  assert.equal(await readFile(paths.logPath, "utf8") !== "", true);
  assert.equal(await readFile(paths.errorPath, "utf8"), "private\n");
  assert.equal((await store.get("escaped"))?.intrinsicUsage?.input, 0);
});

test("child activity uses only the latest visible assistant text", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-child-activity-"));
  const logPath = join(root, "child.jsonl");
  await writeFile(logPath, [
    JSON.stringify({ type: "message_update", message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "First line" }],
    } }),
    JSON.stringify({ type: "message_end", message: {
      role: "assistant",
      content: [{ type: "text", text: "Progress update\nReading tests now" }],
    } }),
    "",
  ].join("\n"));
  assert.equal(await latestAssistantLine(logPath), "Reading tests now");
  const detail = formatChildDetail({ record: record("detail", "running"), activity: "Reading tests now" });
  assert.match(detail, /LATEST ACTIVITY\nReading tests now/);
  assert.doesNotMatch(detail, /private reasoning/);
});

test("tree projection and usage include every descendant exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-tree-usage-"));
  const plannerLog = join(root, "planner.jsonl");
  const workerLog = join(root, "worker.jsonl");
  const usage = (input: number, output: number, cost: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
  await writeFile(plannerLog, `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], usage: usage(10, 2, .01) } })}\n`);
  await writeFile(workerLog, `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], usage: usage(20, 3, .02) } })}\n`);
  const planner = { ...record("planner", "completed"), childLogPath: plannerLog, createdAt: new Date(0).toISOString() };
  const worker = { ...record("worker", "completed"), parentSessionId: "planner-session", parentDelegationId: "planner", childLogPath: workerLog, createdAt: new Date(1).toISOString() };
  const scout = { ...record("scout", "completed"), parentSessionId: "worker-session", parentDelegationId: "worker", createdAt: new Date(2).toISOString() };
  const researcher = { ...record("researcher", "completed"), parentSessionId: "planner-session", parentDelegationId: "planner", createdAt: new Date(3).toISOString() };
  const records = [researcher, scout, worker, planner];
  const tree = delegationTree(records, "parent");
  assert.deepEqual(tree.map((item) => item.id), ["planner", "worker", "scout", "researcher"]);
  assert.equal(delegationDepth(scout, records), 2);
  assert.deepEqual(tree.map((item) => delegationTreePrefix(item, records)), ["", "├── ", "│   └── ", "└── "]);
  assert.deepEqual(
    tree.slice(0, 3).map((item) => delegationTreePrefix(item, records, tree.slice(0, 3))),
    ["", "└── ", "    └── "],
  );
  assert.equal((await intrinsicUsage(plannerLog)).input, 10);
  const total = await treeUsage(planner, records);
  assert.equal(total.input, 30);
  assert.equal(total.output, 5);
  assert.equal(total.cost.total, .03);
});

test("persistent child control channel writes RPC follow-up commands", async () => {
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
    await launcher.message(child, "Prioritize the regression", "followUp");
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await reader.read(buffer);
    assert.deepEqual(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8").trim()), {
      type: "prompt",
      message: "Prioritize the regression",
      streamingBehavior: "followUp",
    });

    const logPath = join(stateRoot, "waiting.jsonl");
    await writeFile(logPath, `${JSON.stringify({ type: "tool_execution_update", toolName: "wait_for_children" })}\n`);
    await launcher.message({ ...child, childLogPath: logPath }, "Close the loop", "steer");
    const second = Buffer.alloc(4096);
    const nextRead = await reader.read(second);
    assert.deepEqual(
      second.subarray(0, nextRead.bytesRead).toString("utf8").trim().split("\n").map((line) => JSON.parse(line)),
      [
        { type: "abort" },
        { type: "prompt", message: "Close the loop" },
      ],
    );
  } finally {
    await reader.close();
  }
});

test("subagents toggles the thinker definition without pausing concurrent parent work", async () => {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const tools = new Map<string, any>();
  const entries: any[] = [];
  const injectedMessages: string[] = [];
  let active = ["read"];
  let effort = "low";
  let selectedModel = "gpt-5.6-luna";
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, options.handler);
    },
    registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
    getActiveTools: () => [...active],
    getAllTools: () => TOOL_NAMES.map((name) => ({ name })),
    setActiveTools(next: string[]) { active = [...next]; },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    sendUserMessage(message: string) { injectedMessages.push(message); },
    getThinkingLevel: () => effort,
    setThinkingLevel(next: string) { effort = next; },
    setModel: async (model: { id: string }) => { selectedModel = model.id; return true; },
  } as unknown as ExtensionAPI;
  const capabilities = new SessionCapabilityController();
  let forceAbandonCalls = 0;
  let plannerSpawn: Record<string, any> | undefined;
  let workspaceCreate: Record<string, any> | undefined;
  let childRecords: DelegationRecord[] = [{
    ...record("visible", "running"),
    agent: { ...record("visible", "running").agent, name: "planner" },
    task: { objective: `task ${"overflow ".repeat(30)}`, uncertaintyHandling: "best-effort" as const },
  }, {
    ...record("active-worker", "running"),
    parentSessionId: "planner-session",
    parentDelegationId: "visible",
    agent: { ...record("active-worker", "running").agent, name: "worker" },
  }, {
    ...record("active-scout", "running"),
    parentSessionId: "worker-session",
    parentDelegationId: "active-worker",
    task: { objective: `nested ${"overflow ".repeat(30)}`, uncertaintyHandling: "best-effort" },
  }, {
    ...record("finished-descendant", "completed"),
    parentSessionId: "planner-session",
    parentDelegationId: "visible",
    task: { objective: "completed descendant", uncertaintyHandling: "best-effort" },
  }];
  let widgetFactory: ((tui: unknown, theme: { fg: (_color: string, text: string) => string }) => {
    render(width: number): string[];
  }) | undefined;
  const customViews: { before: string[]; afterG: string[]; afterg: string[]; afterEnd: string[]; afterRight: string[]; options: unknown }[] = [];
  let inspectChoices: string[] = [];
  let waitProgress: { content?: Array<{ type: string; text?: string }>; details?: { nodes?: Array<{ id: string }> } } | undefined;
  capabilities.bindTools({ getActiveTools: () => active, setActiveTools: (next) => { active = next; } });
  const catalog = agentCatalog();
  registerSubagents(pi, {
    store: {} as DelegationStore,
    orchestrator: {
      children: async () => childRecords,
      all: async () => childRecords,
      wait: async (_parentSessionId: string, options: { onProgress?: (records: DelegationRecord[]) => Promise<void> }) => {
        await options.onProgress?.(childRecords.filter((record) => record.parentSessionId === "parent"));
        return [{ ...record("visible", "completed"), usageAttributedAt: new Date(0).toISOString() }];
      },
      spawnChild: async (request: Record<string, any>) => {
        plannerSpawn = request;
        return {
          ...record("planned", "running"),
          cwd: request.parentCwd,
          agent: request.agent,
          workspace: { phase: "active", attachment: request.workspace },
        };
      },
      forceAbandonChildren: async () => { forceAbandonCalls += 1; return []; },
    } as unknown as SubagentOrchestrator,
    capabilities,
    childDelegationId: "",
    workspace: {
      kind: "jj",
      create: async (request: Record<string, any>) => {
        workspaceCreate = request;
        return {
          backend: "jj" as const,
          purpose: "delegation" as const,
          repoRoot: "/repo",
          sourceWorkspace: "default",
          sourcePath: "/repo",
          baseChangeId: "base",
          name: request.name,
          path: `/repo/.jj/workspaces/${request.name}`,
          rootChangeId: "root",
        };
      },
    } as unknown as WorkspacePort,
    discoverAgents: () => catalog,
    loadInstructions: () => ({ system: "" }),
  });
  assert.match(
    tools.get("subagent")?.promptGuidelines.join("\n") ?? "",
    /Spawning is not completion.*repeatedly call wait_for_children/s,
  );
  assert.match(
    tools.get("workspace_subagent")?.promptGuidelines.join("\n") ?? "",
    /Launching a workspace child is not completion.*Repeatedly call wait_for_children/s,
  );
  assert.match(tools.get("wait_for_children")?.description ?? "", /Wait-any.*call repeatedly/);
  assert.match(
    tools.get("wait_for_children")?.promptGuidelines.join("\n") ?? "",
    /each call returns after one.*not after all.*Keep calling until.*uncollected/s,
  );
  assert.match(
    tools.get("report_to_parent")?.promptGuidelines.join("\n") ?? "",
    /repeatedly call wait_for_children.*consume every direct-child terminal result/s,
  );
  const notifications: string[] = [];
  const ctx = {
    mode: "tui",
    cwd: "/repo",
    model: { provider: "openai-codex", id: selectedModel },
    modelRegistry: {
      find: (_provider: string, model: string) => ({ provider: "openai-codex", id: model }),
    },
    isProjectTrusted: () => true,
    sessionManager: {
      getEntries: () => entries,
      getSessionId: () => "parent",
      getSessionFile: () => "/session.jsonl",
    },
    ui: {
      notify(message: string) { notifications.push(message); },
      setWidget(_key: string, value?: typeof widgetFactory) { widgetFactory = value; },
      select(_title: string, choices: string[]) { inspectChoices = choices; return Promise.resolve(undefined); },
      custom(factory: Function, options?: unknown) {
        return new Promise<void>((resolve) => {
          const tui = { requestRender() {} };
          const theme = { fg: (_color: string, text: string) => text };
          const component = factory(tui, theme, {}, resolve);
          const before = component.render(100);
          component.handleInput?.("G");
          const afterG = component.render(100);
          component.handleInput?.("g");
          const afterg = component.render(100);
          component.handleInput?.("\u001b[F");
          const afterEnd = component.render(100);
          component.handleInput?.("\u001b[C");
          const afterRight = component.render(100);
          customViews.push({ before, afterG, afterg, afterEnd, afterRight, options });
          component.handleInput?.("\u001b");
        });
      },
    },
  };
  await handlers.get("session_start")?.[0]({ reason: "startup" }, ctx);
  assert.equal(handlers.has("tool_call"), false);
  await commands.get("subagents")?.("", ctx);
  assert.equal(selectedModel, "gpt-5.6-sol");
  assert.equal(effort, "high");
  assert.deepEqual(active, catalog.root.tools);
  assert.deepEqual(
    capabilities.snapshot().capabilities.map((capability) => capability.id),
    ["subagents"],
  );
  assert.match(notifications.at(-1) ?? "", /thinker/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(widgetFactory, undefined);

  await commands.get("subagents")?.("list", ctx);
  assert.equal(customViews[0]?.options, undefined);
  assert.match(customViews[0]?.before.join("\n") ?? "", /\[Active \(3\)\]/);
  assert.match(customViews[0]?.before.join("\n") ?? "", /planner · running[\s\S]*└── worker · running[\s\S]*    └── scout · running/);
  assert.doesNotMatch(customViews[0]?.before.join("\n") ?? "", /completed descendant/);
  assert.match(customViews[0]?.afterRight.join("\n") ?? "", /\[Inactive \(1\)\]/);
  assert.match(customViews[0]?.afterRight.join("\n") ?? "", /completed descendant/);
  const nestedLine = customViews[0]?.before.find((line) => line.includes("└── scout")) ?? "";
  assert.match(nestedLine.replace(/\u001b\[[0-9;]*m/g, ""), /…$/);
  assert.ok(customViews[0]?.before.every((line) => line.replace(/\u001b\[[0-9;]*m/g, "").length <= 100));
  await commands.get("subagents")?.("inspect", ctx);
  assert.match(inspectChoices.join("\n"), /visible · planner[\s\S]*├── active-worker · worker[\s\S]*│   └── active-scout · scout[\s\S]*└── finished-descendant · scout/);
  await commands.get("subagents")?.("inspect visible", ctx);
  assert.equal(customViews[1]?.options, undefined);
  assert.match(customViews[1]?.before.join("\n") ?? "", /\[Inspect · planner · visible\]/);
  assert.notDeepEqual(customViews[1]?.before, customViews[1]?.afterG);
  assert.deepEqual(customViews[1]?.before, customViews[1]?.afterg);
  assert.notDeepEqual(customViews[1]?.before, customViews[1]?.afterEnd);
  await commands.get("subagents")?.("inspect finished-descendant", ctx);
  assert.match(customViews[2]?.before.join("\n") ?? "", /\[Inspect · scout · finished-descendant\]/);
  assert.match(customViews[2]?.before.join("\n") ?? "", /completed/);

  await tools.get("wait_for_children")?.execute(
    "tool",
    {},
    undefined,
    (update: typeof waitProgress) => { waitProgress = update; },
    ctx,
  );
  const waitText = waitProgress?.content?.map((part) => part.text ?? "").join("\n") ?? "";
  assert.match(waitText, /planner · running[\s\S]*└── worker · running[\s\S]*    └── scout · running/);
  assert.doesNotMatch(waitText, /completed descendant/);
  assert.deepEqual(waitProgress?.details?.nodes?.map((node) => node.id), ["visible", "active-worker", "active-scout"]);

  await handlers.get("agent_settled")?.[0]({}, ctx);
  assert.match(injectedMessages.at(-1) ?? "", /call wait_for_children repeatedly/);

  await tools.get("workspace_subagent")?.execute(
    "tool",
    { agent: "planner", name: "planned", task: { objective: "Plan isolated work" } },
    undefined,
    undefined,
    ctx,
  );
  assert.deepEqual(workspaceCreate, { cwd: "/repo", name: "planned", purpose: "delegation" });
  assert.equal(plannerSpawn?.agent.name, "planner");
  assert.equal(plannerSpawn?.parentCwd, "/repo/.jj/workspaces/planned");
  assert.equal(plannerSpawn?.workspace.backend, "jj");

  await tools.get("workspace_subagent")?.execute(
    "tool",
    { agent: "worker", name: "bounded", task: { objective: "Implement bounded work" } },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(plannerSpawn?.agent.name, "worker");
  assert.equal(plannerSpawn?.parentCwd, "/repo/.jj/workspaces/bounded");

  childRecords = [];
  await commands.get("subagents")?.("", ctx);
  assert.equal(selectedModel, "gpt-5.6-luna");
  assert.equal(effort, "low");
  assert.deepEqual(active, ["read"]);

  childRecords = [record("visible", "running")];
  await commands.get("subagents")?.("on", ctx);
  await commands.get("subagents")?.("force-off", ctx);
  assert.equal(forceAbandonCalls, 1);
  assert.equal(selectedModel, "gpt-5.6-luna");
  assert.equal(effort, "low");
  assert.deepEqual(active, ["read"]);
  assert.match(notifications.at(-1) ?? "", /terminated 0/);
});

function agent(name: string, children: string[], canSpawn: boolean): AgentDefinition {
  return {
    name,
    description: `${name} role`,
    root: name === "thinker",
    provider: "openai-codex",
    model: `model-${name}`,
    effort: "low",
    tools: canSpawn ? ["read", "subagent"] : ["read"],
    allowedChildren: children,
    uncertaintyHandling: name === "worker" ? "ask-parent" : "best-effort",
    systemPrompt: `${name} prompt`,
    source: "packaged",
    filePath: `/agents/${name}.md`,
    contentHash: `hash-${name}`,
  };
}

function agentCatalog(): AgentCatalog {
  const thinker: AgentDefinition = {
    ...agent("thinker", ["planner", "worker", "scout", "researcher"], true),
    tools: TOOL_NAMES.filter((name) => name !== "report_to_parent" && name !== "ask_parent"),
    effort: "high",
    model: "gpt-5.6-sol",
  };
  const planner = agent("planner", ["worker", "scout", "researcher"], true);
  const worker = agent("worker", ["scout", "researcher"], true);
  const scout = agent("scout", [], false);
  const researcher = agent("researcher", [], false);
  const agents = [thinker, planner, worker, scout, researcher];
  return { root: thinker, agents, byName: new Map(agents.map((value) => [value.name, value])) };
}

function record(
  id: string,
  phase: "running" | "completed",
  pid?: number,
): DelegationRecord {
  const definition = agent("scout", [], false);
  return {
    version: 3,
    id,
    parentSessionId: "parent",
    cwd: "/repo",
    task: { objective: `task ${id}`, uncertaintyHandling: "best-effort" },
    agent: { ...definition, tools: [...definition.tools], allowedChildren: [...definition.allowedChildren] },
    execution: phase === "running"
      ? { phase }
      : {
          phase,
          report: { outcome: "completed", summary: "done", reportedAt: new Date(0).toISOString() },
        },
    ...(pid ? { childPid: pid } : {}),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}
