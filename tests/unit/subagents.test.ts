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
import type { ChildContextCoordinator } from "../../packages/pi-tai/src/concurrency/coordinator.ts";
import { FileChildContextStore, type PersistedChildContextV4 } from "../../packages/pi-tai/src/concurrency/persistence.ts";
import type { AgentCatalog, AgentDefinition } from "../../packages/pi-tai/src/subagents/agents.ts";
import {
  PARENT_TOOL_NAMES,
  activeToolsForMode,
  childProtocolToolsForUncertainty,
  composePiTaiInstructions,
  parseSubagentsCommand,
} from "../../packages/pi-tai/src/subagents/domain.ts";
import {
  PiChildProcessLauncher,
  managedChildRuntimePaths,
} from "../../packages/pi-tai/src/subagents/launcher.ts";
import { SubagentOrchestrator } from "../../packages/pi-tai/src/subagents/orchestrator.ts";
import {
  canonicalNormalChildren,
  isAssignedDocumentationPath,
  isDocumentationPath,
  registerSubagents,
  usesPrivateSdkSubagentContexts,
} from "../../packages/pi-tai/src/subagents/register.ts";
import {
  FileDelegationStore,
  MemoryDelegationStore,
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

test("canonical child policy cannot be broadened by agent overrides", () => {
  assert.deepEqual([...canonicalNormalChildren("orchestrator")], ["scout", "researcher"]);
  assert.deepEqual([...canonicalNormalChildren("implementation-lead")], ["worker", "scout", "researcher"]);
  assert.deepEqual([...canonicalNormalChildren("worker")], ["scout", "researcher"]);
  assert.deepEqual([...canonicalNormalChildren("custom")], []);
});

test("documenter path policy permits only explicitly assigned repository docs", () => {
  assert.equal(isDocumentationPath("/repo", "docs/concurrency/README.md"), true);
  assert.equal(isDocumentationPath("/repo", "README.md"), true);
  assert.equal(isDocumentationPath("/repo", "packages/example/README.md"), true);
  assert.equal(isDocumentationPath("/repo", "src/index.ts"), false);
  assert.equal(isDocumentationPath("/repo", "packages/pi-tai/agents/orchestrator.md"), false);
  assert.equal(isDocumentationPath("/repo", "../outside.md"), false);
  const resources = [{ type: "file", value: "docs/concurrency/README.md" }];
  assert.equal(isAssignedDocumentationPath("/repo", "docs/concurrency/README.md", resources), true);
  assert.equal(isAssignedDocumentationPath("/repo", "docs/GLOSSARY.md", resources), false);
});

test("runtime mode explicitly selects private SDK or legacy child-process composition", () => {
  assert.equal(usesPrivateSdkSubagentContexts("pi-cli"), true);
  assert.equal(usesPrivateSdkSubagentContexts("host-worker"), true);
  assert.equal(usesPrivateSdkSubagentContexts("legacy-child-process"), false);
});

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
  assert.deepEqual(childProtocolToolsForUncertainty("ask-parent"), [
    "message_parent", "report_to_parent", "report_status", "ask_parent",
  ]);
  for (const handling of ["block", "best-effort"] as const) {
    assert.deepEqual(childProtocolToolsForUncertainty(handling), [
      "message_parent", "report_to_parent", "report_status",
    ]);
  }
});

test("instruction composition describes sparse shared-cwd delegation without workspace policy", () => {
  const prompt = composePiTaiInstructions({
    basePrompt: "base",
    mode: "root",
    agentName: "orchestrator",
    systemInstructions: "system",
    roleInstructions: "think carefully",
    availableChildren: [{ name: "worker", description: "implements" }],
  });
  assert.match(prompt, /agent="orchestrator"/);
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
  const root = await mkdtemp(join(tmpdir(), "pi-tai-implementation-lead-workspace-"));
  const store = new FileDelegationStore(root);
  const orchestrator = new SubagentOrchestrator({
    store,
    launcher: {
      launch: async () => ({ pid: process.pid, logPath: "log", controlPath: "fifo", promptPath: "prompt" }),
      message: async () => undefined,
      cleanup: async () => undefined,
    },
  });
  const orchestratorAgent = {
    ...agent("orchestrator", ["implementation-lead"], true),
    root: true,
    tools: ["read", "subagent", "workspace_subagent"],
  };
  const implementationLead = agent("implementation-lead", ["worker", "scout", "researcher"], true);
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
    agent: implementationLead,
    caller: orchestratorAgent,
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
  const root = await mkdtemp(join(tmpdir(), "pi-tai-implementation-lead-workspace-stop-"));
  const store = new FileDelegationStore(root);
  const orchestrator = new SubagentOrchestrator({
    store,
    launcher: {
      launch: async () => ({ pid: process.pid, logPath: "log", controlPath: "fifo", promptPath: "prompt" }),
      message: async () => undefined,
      cleanup: async () => undefined,
    },
  });
  const orchestratorAgent = {
    ...agent("orchestrator", ["implementation-lead"], true),
    root: true,
    tools: ["read", "subagent", "workspace_subagent"],
  };
  const implementationLead = agent("implementation-lead", ["worker"], true);
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
    agent: implementationLead,
    caller: orchestratorAgent,
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
  const plannerLog = join(root, "implementationLead.jsonl");
  const workerLog = join(root, "worker.jsonl");
  const usage = (input: number, output: number, cost: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
  await writeFile(plannerLog, `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], usage: usage(10, 2, .01) } })}\n`);
  await writeFile(workerLog, `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], usage: usage(20, 3, .02) } })}\n`);
  const implementationLead = { ...record("implementation-lead", "completed"), childLogPath: plannerLog, createdAt: new Date(0).toISOString() };
  const worker = { ...record("worker", "completed"), parentSessionId: "implementation-lead-session", parentDelegationId: "implementation-lead", childLogPath: workerLog, createdAt: new Date(1).toISOString() };
  const scout = { ...record("scout", "completed"), parentSessionId: "worker-session", parentDelegationId: "worker", createdAt: new Date(2).toISOString() };
  const researcher = { ...record("researcher", "completed"), parentSessionId: "implementation-lead-session", parentDelegationId: "implementation-lead", createdAt: new Date(3).toISOString() };
  const records = [researcher, scout, worker, implementationLead];
  const tree = delegationTree(records, "parent");
  assert.deepEqual(tree.map((item) => item.id), ["implementation-lead", "worker", "scout", "researcher"]);
  assert.equal(delegationDepth(scout, records), 2);
  assert.deepEqual(tree.map((item) => delegationTreePrefix(item, records)), ["", "├── ", "│   └── ", "└── "]);
  assert.deepEqual(
    tree.slice(0, 3).map((item) => delegationTreePrefix(item, records, tree.slice(0, 3))),
    ["", "└── ", "    └── "],
  );
  assert.equal((await intrinsicUsage(plannerLog)).input, 10);
  const total = await treeUsage(implementationLead, records);
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

test("abandon_child reports pending cancellation instead of hanging the public tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-abandon-tool-pending-"));
  const tools = new Map<string, any>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const store = new MemoryDelegationStore();
  const child = record("visible", "running");
  await store.create(child);
  const context: PersistedChildContextV4 = {
    version: 4, contextId: child.id, rootSessionId: "parent", cwd: child.cwd, task: child.task, agent: child.agent,
    execution: { phase: "cancelling", cycleId: "cycle-1", requestedAt: "now", reason: "parent request" },
    events: [], usage: [], telemetryGaps: [], createdAt: "now", updatedAt: "now",
  };
  const coordinator = {
    getRuntime: (id: string) => id === child.id ? {} : undefined,
    cancel: async () => ({ disposition: "pending", contexts: [context], pendingContextIds: [child.id] }),
    get: async () => context,
    list: async () => [context],
    resume: async () => context,
    message: async () => undefined,
    releaseRuntime: () => undefined,
    disposeRoot: async () => undefined,
  } as unknown as ChildContextCoordinator;
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
    registerCommand() {},
    getActiveTools: () => ["read"],
    getAllTools: () => TOOL_NAMES.map((name) => ({ name })),
    setActiveTools() {}, appendEntry() {}, sendMessage() {},
    getThinkingLevel: () => "low", setThinkingLevel() {}, setModel: async () => true,
  } as unknown as ExtensionAPI;
  const orchestrator = {
    child: async () => child,
    children: async () => [child],
    all: async () => [child],
  } as unknown as SubagentOrchestrator;
  registerSubagents(pi, {
    runtime: "legacy-child-process",
    store, orchestrator, coordinator, contextStore: new FileChildContextStore(join(root, "contexts")), agentDir: root,
    discoverAgents: () => agentCatalog(), loadInstructions: () => ({ system: "" }),
  });
  const ctx = {
    cwd: "/repo", mode: "print", model: { provider: "openai-codex", id: "model" },
    modelRegistry: { find: () => ({ provider: "openai-codex", id: "model" }) }, isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => "parent", getSessionFile: () => "/session.jsonl",
      getEntries: () => [{ type: "custom", customType: "pi-tai-subagent-role", data: { mode: "root", agentName: "orchestrator" } }],
    },
    ui: { notify() {}, setWidget() {} },
  };
  await handlers.get("session_start")?.[0]({ reason: "startup" }, ctx);
  const output = await tools.get("abandon_child").execute("tool", { delegationId: child.id }, undefined, undefined, ctx);
  assert.match(output.content[0]?.text ?? "", /Cancellation requested.*still settling/);
  assert.equal((await store.get(child.id))?.execution.phase, "running");
  await handlers.get("session_shutdown")?.[0]({ reason: "quit" }, ctx);
});

test("acknowledging a terminal child attributes its full tree usage exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-ack-usage-"));
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const tools = new Map<string, any>();
  const store = new MemoryDelegationStore();
  const child = record("child-usage", "completed");
  await store.create(child);
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
    registerCommand() {}, getActiveTools: () => ["read"], getAllTools: () => TOOL_NAMES.map((name) => ({ name })),
    setActiveTools() {}, appendEntry() {}, sendMessage() {}, getThinkingLevel: () => "low", setThinkingLevel() {}, setModel: async () => true,
  } as unknown as ExtensionAPI;
  registerSubagents(pi, {
    runtime: "legacy-child-process",
    store,
    orchestrator: {
      children: async () => [child],
      child: async () => child,
      all: async () => [child],
    } as unknown as SubagentOrchestrator,
    contextStore: new FileChildContextStore(join(root, "contexts")),
    coordinator: { getRuntime: () => ({}) } as unknown as ChildContextCoordinator,
    protocol: { acknowledge: async () => ({ kind: "terminal", eventId: "terminal-1" }) } as any,
    usageLedger: {
      totals: async () => ({ total: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 1.25 } }),
    } as any,
    agentDir: root,
    discoverAgents: () => agentCatalog(),
    loadInstructions: () => ({ system: "" }),
  });
  const ctx = {
    cwd: "/repo", mode: "print", model: undefined, modelRegistry: { find: () => ({ provider: "openai-codex", id: "model" }) }, isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => "parent", getSessionFile: () => "/session.jsonl",
      getEntries: () => [{ type: "custom", customType: "pi-tai-subagent-role", data: { mode: "root", agentName: "orchestrator" } }],
    },
    ui: { notify() {}, setWidget() {} },
  };
  await handlers.get("session_start")?.[0]({ reason: "startup" }, ctx);

  const first = await tools.get("ack_child_event").execute("tool-1", { contextId: child.id, eventId: "terminal-1" }, undefined, undefined, ctx);
  assert.deepEqual(first.usage, {
    input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1.25 },
  });
  const second = await tools.get("ack_child_event").execute("tool-2", { contextId: child.id, eventId: "terminal-1" }, undefined, undefined, ctx);
  assert.equal(second.usage, undefined);
});

test("orchestrator can prompt the user to approve or deny the current persisted plan", async () => {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const tools = new Map<string, any>();
  const sent: Array<{ message: string; options: unknown }> = [];
  let active: string[] = [];
  let effort = "high";
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerCommand() {},
    registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
    getActiveTools: () => [...active],
    getAllTools: () => [...new Set([...TOOL_NAMES, ...tools.keys()])].map((name) => ({ name })),
    setActiveTools(next: string[]) { active = [...next]; },
    appendEntry() {},
    getThinkingLevel: () => effort,
    setThinkingLevel(next: string) { effort = next; },
    setModel: async () => true,
    sendUserMessage(message: string, options: unknown) { sent.push({ message, options }); },
  } as unknown as ExtensionAPI;
  const revision = {
    revisionId: "plan-current",
    markdown: Array.from({ length: 40 }, (_, index) => `${index + 1}. Plan step ${index + 1}`).join("\n"),
  };
  registerSubagents(pi, {
    runtime: "legacy-child-process",
    store: {} as DelegationStore,
    orchestrator: {} as SubagentOrchestrator,
    isolatedJj: {
      initialize: async () => undefined,
      tasks: { findRoot: async () => ({ taskId: "task-root", planRevisions: [revision] }) },
    } as any,
    discoverAgents: () => agentCatalog(),
    loadInstructions: () => ({ system: "" }),
  });
  let selected = "Approve";
  const ctx = {
    mode: "tui", hasUI: true, cwd: "/repo", isProjectTrusted: () => true,
    modelRegistry: { find: () => ({ provider: "openai-codex", id: "gpt-5.6-sol" }) },
    sessionManager: {
      getEntries: () => [{ type: "custom", customType: "pi-tai-subagent-role", data: { mode: "root", agentName: "orchestrator" } }],
      getSessionId: () => "root-session", getSessionFile: () => "/session.jsonl",
    },
    ui: {
      notify() {}, setWidget() {},
      custom(factory: Function) {
        return new Promise<void>((resolve) => {
          const component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, resolve);
          const top = component.render(100);
          assert.match(top.join("\n"), /1\. Plan step 1/);
          assert.match(top.join("\n"), /Ctrl\+B\/F page · Ctrl\+U\/D half-page/);
          assert.match(top.join("\n"), /Enter\s+approve · Esc deny/);
          component.handleInput("\u0006");
          const pageDown = component.render(100);
          assert.notDeepEqual(pageDown, top);
          component.handleInput("\u0002");
          assert.deepEqual(component.render(100), top);
          component.handleInput("\u0004");
          const halfDown = component.render(100);
          assert.notDeepEqual(halfDown, top);
          component.handleInput("\u0015");
          assert.deepEqual(component.render(100), top);
          component.handleInput(selected === "Approve" ? "\r" : "\u001b");
        });
      },
      select: async () => { throw new Error("TUI approval must not open a second selection dialog."); },
    },
  };
  await handlers.get("session_start")?.[0]({ reason: "startup" }, ctx);
  const approved = await tools.get("request_plan_approval").execute("approval-1", {}, undefined, undefined, ctx);
  assert.match(approved.content[0].text, /User approved plan plan-current/);
  assert.deepEqual(sent.at(-1), { message: "I approve this plan: plan-current.", options: { deliverAs: "steer" } });
  selected = "Deny";
  const denied = await tools.get("request_plan_approval").execute("approval-2", {}, undefined, undefined, ctx);
  assert.match(denied.content[0].text, /User denied plan plan-current/);
  assert.deepEqual(sent.at(-1), { message: "I do not approve this plan: plan-current.", options: { deliverAs: "steer" } });
});

test("subagents toggles the orchestrator definition without pausing concurrent parent work", async () => {
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
    sendUserMessage(message: string) { injectedMessages.push(`user:${message}`); },
    sendMessage(message: { content: string; display?: boolean }) { injectedMessages.push(`custom:${message.display}:${message.content}`); },
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
    agent: { ...record("visible", "running").agent, name: "implementation-lead" },
    task: { objective: `task ${"overflow ".repeat(30)}`, uncertaintyHandling: "best-effort" as const },
  }, {
    ...record("active-worker", "running"),
    parentSessionId: "implementation-lead-session",
    parentDelegationId: "visible",
    agent: { ...record("active-worker", "running").agent, name: "worker" },
  }, {
    ...record("active-scout", "running"),
    parentSessionId: "worker-session",
    parentDelegationId: "active-worker",
    task: { objective: `nested ${"overflow ".repeat(30)}`, uncertaintyHandling: "best-effort" },
  }, {
    ...record("finished-descendant", "completed"),
    parentSessionId: "implementation-lead-session",
    parentDelegationId: "visible",
    task: { objective: "completed descendant", uncertaintyHandling: "best-effort" },
  }];
  let widgetFactory: ((tui: unknown, theme: { fg: (_color: string, text: string) => string }) => {
    render(width: number): string[];
  }) | undefined;
  const customViews: { before: string[]; afterG: string[]; afterg: string[]; afterEnd: string[]; afterRight: string[]; options: unknown }[] = [];
  let inspectChoices: string[] = [];
  capabilities.bindTools({ getActiveTools: () => active, setActiveTools: (next) => { active = next; } });
  const catalog = agentCatalog();
  registerSubagents(pi, {
    runtime: "legacy-child-process",
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
    /Spawning is not completion.*repeatedly use await_child_event/s,
  );
  assert.match(
    tools.get("request_plan_approval")?.promptGuidelines.join("\n") ?? "",
    /instead of asking the user to type a separate approval response/,
  );
  assert.match(
    tools.get("workspace_subagent")?.promptGuidelines.join("\n") ?? "",
    /Launching a workspace child is not completion.*Use await_child_event/s,
  );
  assert.match(tools.get("await_child_event")?.description ?? "", /Suspend without polling/);
  assert.match(tools.get("ack_child_event")?.description ?? "", /Acknowledge one delivered/);
  assert.match(
    tools.get("report_to_parent")?.promptGuidelines.join("\n") ?? "",
    /repeatedly use await_child_event.*acknowledge every direct-child terminal event/s,
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
  assert.equal(handlers.has("tool_call"), true);
  for (const name of ["insert_change", "acquire_file_set", "checkpoint_change"]) {
    const properties = tools.get(name)?.parameters?.properties ?? {};
    for (const forbidden of ["cwd", "changeId", "wipChangeId", "targetChangeId", "revset", "fileset", "argv", "operationId"]) {
      assert.equal(forbidden in properties, false, `${name} exposes ${forbidden}`);
    }
  }
  await commands.get("subagents")?.("", ctx);
  assert.equal(selectedModel, "gpt-5.6-sol");
  assert.equal(effort, "high");
  assert.deepEqual(active, catalog.root.tools);
  assert.deepEqual(
    capabilities.snapshot().capabilities.map((capability) => capability.id),
    ["subagents"],
  );
  assert.match(notifications.at(-1) ?? "", /orchestrator/);
  const rootGuard = handlers.get("tool_call")?.[0];
  assert.match((await rootGuard?.({ toolName: "write", toolCallId: "write-1", input: { path: "README.md", content: "mutate" } }, ctx))?.reason ?? "", /Orchestrator is read-only/);
  assert.match((await rootGuard?.({ toolName: "bash", toolCallId: "bash-1", input: { command: "rm README.md" } }, ctx))?.reason ?? "", /no shell execution authority/);
  await assert.rejects(tools.get("subagent")?.execute("direct-worker", { agent: "worker", task: { objective: "Bypass Implementation Lead" } }, undefined, undefined, ctx), /cannot launch Workers directly/);
  await assert.rejects(tools.get("subagent")?.execute("direct-lead", { agent: "implementation-lead", task: { objective: "Bypass workspace" } }, undefined, undefined, ctx), /workspace_subagent/);
  await assert.rejects(tools.get("subagent")?.execute("direct-review", { agent: "reviewer", task: { objective: "Review without range" } }, undefined, undefined, ctx), /prepare_workspace_review/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(widgetFactory, undefined);

  await commands.get("subagents")?.("list", ctx);
  assert.equal(customViews[0]?.options, undefined);
  assert.match(customViews[0]?.before.join("\n") ?? "", /\[Active \(3\)\]/);
  assert.match(customViews[0]?.before.join("\n") ?? "", /implementation-lead · running[\s\S]*└── worker · running[\s\S]*    └── scout · running/);
  assert.doesNotMatch(customViews[0]?.before.join("\n") ?? "", /completed descendant/);
  assert.match(customViews[0]?.afterRight.join("\n") ?? "", /\[Inactive \(1\)\]/);
  assert.match(customViews[0]?.afterRight.join("\n") ?? "", /completed descendant/);
  const nestedLine = customViews[0]?.before.find((line) => line.includes("└── scout")) ?? "";
  assert.match(nestedLine.replace(/\u001b\[[0-9;]*m/g, ""), /…$/);
  assert.ok(customViews[0]?.before.every((line) => line.replace(/\u001b\[[0-9;]*m/g, "").length <= 100));
  await commands.get("subagents")?.("inspect", ctx);
  assert.match(inspectChoices.join("\n"), /visible · implementation-lead[\s\S]*├── active-worker · worker[\s\S]*│   └── active-scout · scout[\s\S]*└── finished-descendant · scout/);
  await commands.get("subagents")?.("inspect visible", ctx);
  assert.equal(customViews[1]?.options, undefined);
  assert.match(customViews[1]?.before.join("\n") ?? "", /\[Inspect · implementation-lead · visible\]/);
  assert.notDeepEqual(customViews[1]?.before, customViews[1]?.afterG);
  assert.deepEqual(customViews[1]?.before, customViews[1]?.afterg);
  assert.notDeepEqual(customViews[1]?.before, customViews[1]?.afterEnd);
  await commands.get("subagents")?.("inspect finished-descendant", ctx);
  assert.match(customViews[2]?.before.join("\n") ?? "", /\[Inspect · scout · finished-descendant\]/);
  assert.match(customViews[2]?.before.join("\n") ?? "", /completed/);

  await handlers.get("agent_settled")?.[0]({}, ctx);
  assert.match(injectedMessages.at(-1) ?? "", /^custom:false:.*unresolved or unacknowledged/);

  await assert.rejects(tools.get("workspace_subagent")?.execute(
    "tool",
    { agent: "implementation-lead", taskId: "task-unapproved", name: "planned", task: { objective: "Implement unapproved work" } },
    undefined,
    undefined,
    ctx,
  ), /matching durable task assignment/);
  assert.equal(workspaceCreate, undefined);
  assert.equal(plannerSpawn, undefined);

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
    root: name === "orchestrator",
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
  const orchestrator: AgentDefinition = {
    ...agent("orchestrator", ["implementation-lead", "documenter", "worker", "reviewer", "scout", "researcher"], true),
    tools: TOOL_NAMES.filter((name) => name !== "report_to_parent" && name !== "ask_parent"),
    effort: "high",
    model: "gpt-5.6-sol",
  };
  const implementationLead = agent("implementation-lead", ["worker", "scout", "researcher"], true);
  const documenter = agent("documenter", [], false);
  const reviewer = agent("reviewer", ["scout", "researcher"], true);
  const worker = agent("worker", ["scout", "researcher"], true);
  const scout = agent("scout", [], false);
  const researcher = agent("researcher", [], false);
  const agents = [orchestrator, implementationLead, documenter, reviewer, worker, scout, researcher];
  return { root: orchestrator, agents, byName: new Map(agents.map((value) => [value.name, value])) };
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
