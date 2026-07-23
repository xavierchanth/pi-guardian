import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
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
import { PiChildProcessLauncher } from "../../packages/pi-tai/src/subagents/launcher.ts";
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
  formatChildDetail,
  latestAssistantLine,
} from "../../packages/pi-tai/src/subagents/ui.ts";

const execFileAsync = promisify(execFile);
const TOOL_NAMES = [
  "read", "write", "edit", "grep", "find", "ls", "bash", "update_plan",
  ...PARENT_TOOL_NAMES, "report_to_parent", "ask_parent",
];

test("subagent mode tools are exact and unified command parsing remains stable", () => {
  assert.deepEqual(parseSubagentsCommand(""), { action: "toggle" });
  assert.deepEqual(parseSubagentsCommand("status"), { action: "status" });
  assert.deepEqual(parseSubagentsCommand("off"), { action: "off" });
  assert.deepEqual(parseSubagentsCommand("force-off"), { action: "force-off" });
  assert.deepEqual(parseSubagentsCommand("list"), { action: "list" });
  assert.deepEqual(parseSubagentsCommand("list child-1"), { action: "list", delegationId: "child-1" });
  assert.equal(parseSubagentsCommand("list child-1 extra"), undefined);
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

test("planner workspace integration is explicit, durable, and cleanup follows integration", async () => {
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
    tools: ["read", "subagent", "planner_workspace"],
  };
  const planner = agent("planner", ["worker", "scout", "researcher"], true);
  const attachment = {
    backend: "jj" as const,
    purpose: "delegation" as const,
    repoRoot: "/repo",
    sourceWorkspace: "default",
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
    captureTip: async () => { calls.push("tip"); return { id: "tip", clean: true }; },
    integrate: async () => { calls.push("integrate"); return { conflicted: false, conflictFiles: [] }; },
    finalize: async () => { calls.push("cleanup"); },
  } as unknown as WorkspacePort;
  const integrated = await orchestrator.integrateWorkspace(child.id, workspace);
  assert.equal(integrated.workspace?.phase, "integrated");
  const cleaned = await orchestrator.cleanupWorkspace(child.id, workspace);
  assert.equal(cleaned.workspace?.phase, "cleaned");
  assert.deepEqual(calls, ["tip", "integrate", "cleanup"]);
});

test("planner workspace integration failure enters a non-retryable attention state", async () => {
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
    tools: ["read", "subagent", "planner_workspace"],
  };
  const planner = agent("planner", ["worker"], true);
  const attachment = {
    backend: "jj" as const,
    purpose: "delegation" as const,
    repoRoot: "/repo",
    sourceWorkspace: "default",
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
    captureTip: async () => ({ id: "tip", clean: true }),
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
  const first = await waitForChildren(store, "parent", { until: "next", pollIntervalMs: 1 });
  assert.equal(first.length, 1);
  const second = await waitForChildren(store, "parent", { until: "next", pollIntervalMs: 1 });
  assert.equal(second.length, 1);
  assert.notEqual(first[0]?.id, second[0]?.id);
});

test("wait allows a bounded grace period for a concurrently spawned child", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-wait-grace-"));
  const store = new FileDelegationStore(root);
  const waiting = waitForChildren(store, "parent", {
    until: "next",
    pollIntervalMs: 2,
    initialGraceMs: 100,
  });
  setTimeout(() => void store.create(record("late", "completed")), 10);
  const records = await waiting;
  assert.equal(records[0]?.id, "late");
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
  const waiting = waitForChildren(store, "parent", { until: "all", pollIntervalMs: 1 });
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
  } finally {
    await reader.close();
  }
});

test("subagents toggles the thinker definition without pausing concurrent parent work", async () => {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const tools = new Map<string, any>();
  const entries: any[] = [];
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
    getThinkingLevel: () => effort,
    setThinkingLevel(next: string) { effort = next; },
    setModel: async (model: { id: string }) => { selectedModel = model.id; return true; },
  } as unknown as ExtensionAPI;
  const capabilities = new SessionCapabilityController();
  let forceAbandonCalls = 0;
  let plannerSpawn: Record<string, any> | undefined;
  let workspaceCreate: Record<string, any> | undefined;
  let childRecords = [record("visible", "running")];
  let widgetFactory: ((tui: unknown, theme: { fg: (_color: string, text: string) => string }) => {
    render(width: number): string[];
  }) | undefined;
  capabilities.bindTools({ getActiveTools: () => active, setActiveTools: (next) => { active = next; } });
  const catalog = agentCatalog();
  registerSubagents(pi, {
    store: {} as DelegationStore,
    orchestrator: {
      children: async () => childRecords,
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
    workspace: {
      kind: "jj",
      create: async (request: Record<string, any>) => {
        workspaceCreate = request;
        return {
          backend: "jj" as const,
          purpose: "delegation" as const,
          repoRoot: "/repo",
          sourceWorkspace: "default",
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
  assert.ok(widgetFactory);
  const widgetLines = widgetFactory({}, { fg: (_color, text) => text }).render(100);
  assert.match(widgetLines[0] ?? "", /subagent · scout · task visible/);
  assert.match(widgetLines[1] ?? "", /running · Waiting for the first model update/);

  await tools.get("planner_workspace")?.execute(
    "tool",
    { name: "planned", task: { objective: "Plan isolated work" } },
    undefined,
    undefined,
    ctx,
  );
  assert.deepEqual(workspaceCreate, { cwd: "/repo", name: "planned", purpose: "delegation" });
  assert.equal(plannerSpawn?.agent.name, "planner");
  assert.equal(plannerSpawn?.parentCwd, "/repo/.jj/workspaces/planned");
  assert.equal(plannerSpawn?.workspace.backend, "jj");

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
    ...agent("thinker", ["planner", "scout", "researcher"], true),
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
