import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SessionCapabilityController } from "../capabilities/controller.ts";
import {
  discoverAgentDefinitions,
  validateAgentTools,
  type AgentCatalog,
  type AgentDefinition,
} from "./agents.ts";
import {
  CHILD_PROTOCOL_TOOL_NAMES,
  PARENT_TOOL_NAMES,
  activeToolsForMode,
  composePiTaiInstructions,
  parseSubagentsCommand,
  reconstructSubagentState,
  type PersistedSubagentState,
  type SubagentMode,
} from "./domain.ts";
import { loadPackagedInstructions, type InstructionLoader } from "./instructions.ts";
import { PiChildProcessLauncher } from "./launcher.ts";
import { SubagentOrchestrator } from "./orchestrator.ts";
import {
  FileDelegationStore,
  childReport,
  isResolvedDelegation,
  type AgentDefinitionSnapshot,
  type DelegationRecord,
  type DelegationStore,
} from "./store.ts";
import { TASK_RESOURCE_TYPES } from "./task.ts";
import type { AgentRoleState } from "./state.ts";

const ROLE_ENTRY = "pi-tai-subagent-role";
const CHILD_ENV = "PI_TAI_DELEGATION_ID";
const STORE_ENV = "PI_TAI_DELEGATION_STORE";
const AGENT_ENV = "PI_TAI_AGENT_NAME";
const ALLOWED_ENV = "PI_TAI_ALLOWED_CHILDREN";

export interface SubagentDependencies {
  store?: DelegationStore;
  orchestrator?: SubagentOrchestrator;
  loadInstructions?: InstructionLoader;
  discoverAgents?: (ctx: ExtensionContext) => AgentCatalog;
  childDelegationId?: string;
  capabilities?: SessionCapabilityController;
  agentDir?: string;
  roleState?: AgentRoleState;
}

export function registerSubagents(
  pi: ExtensionAPI,
  dependencies: SubagentDependencies = {},
): void {
  const agentDir = dependencies.agentDir ?? getAgentDir();
  const storeRoot = process.env[STORE_ENV]
    || join(agentDir, "pi-tai", "subagents", "delegations");
  const store = dependencies.store ?? new FileDelegationStore(storeRoot);
  const orchestrator = dependencies.orchestrator ?? new SubagentOrchestrator({
    store,
    launcher: new PiChildProcessLauncher(store),
  });
  const capabilities = dependencies.capabilities;
  const roleState = dependencies.roleState;
  capabilities?.register({
    id: "subagents",
    label: "Subagents",
    description: "Delegate sparse task packets to declarative child agents",
    toolNames: [...PARENT_TOOL_NAMES],
  });
  const loadInstructions = dependencies.loadInstructions ?? loadPackagedInstructions;
  const discover = dependencies.discoverAgents ?? ((ctx: ExtensionContext) =>
    discoverAgentDefinitions({
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
      agentDir,
    }));
  const processChildDelegationId = dependencies.childDelegationId ?? process.env[CHILD_ENV];
  let mode: SubagentMode = "standalone";
  let state: PersistedSubagentState = { mode: "standalone" };
  let catalog: AgentCatalog | undefined;
  let currentAgent: AgentDefinition | undefined;
  let childDelegation: DelegationRecord | undefined;
  let spawnSeenThisTurn = false;
  const parentTools = new Set<string>(PARENT_TOOL_NAMES);

  const loadCatalog = (ctx: ExtensionContext): AgentCatalog => {
    catalog = discover(ctx);
    return catalog;
  };

  const availableToolNames = () => new Set(pi.getAllTools().map((tool) => tool.name));

  const configuredTools = (agent: AgentDefinition, child: boolean): string[] => [
    ...agent.tools,
    ...(child ? CHILD_PROTOCOL_TOOL_NAMES : []),
  ];

  const applyTools = (agent?: AgentDefinition) => {
    if (!agent) {
      pi.setActiveTools(activeToolsForMode(pi.getActiveTools(), "standalone"));
      return;
    }
    pi.setActiveTools(configuredTools(agent, mode === "child"));
  };

  const applyAgentModel = async (agent: AgentDefinition, ctx: ExtensionContext): Promise<boolean> => {
    const model = ctx.modelRegistry.find(agent.provider, agent.model);
    if (!model) {
      ctx.ui.notify(`Agent "${agent.name}" model is unavailable: ${agent.provider}/${agent.model}.`, "error");
      return false;
    }
    if (!await pi.setModel(model)) {
      ctx.ui.notify(`Agent "${agent.name}" has no credentials for ${agent.provider}/${agent.model}.`, "error");
      return false;
    }
    pi.setThinkingLevel(agent.effort);
    if (pi.getThinkingLevel() !== agent.effort) {
      ctx.ui.notify(
        `Agent "${agent.name}" requested ${agent.effort} effort; applied ${pi.getThinkingLevel()}.`,
        "warning",
      );
    }
    return true;
  };

  const activateAgent = async (agent: AgentDefinition, ctx: ExtensionContext): Promise<boolean> => {
    try {
      validateAgentTools(agent, availableToolNames());
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
      return false;
    }
    if (!await applyAgentModel(agent, ctx)) return false;
    currentAgent = agent;
    roleState?.set(agent.name);
    applyTools(agent);
    return true;
  };

  pi.on("session_start", async (event, ctx) => {
    const persisted = reconstructSubagentState(ctx.sessionManager.getEntries());
    const fresh = event.reason === "new" || event.reason === "fork";
    state = processChildDelegationId
      ? { mode: "child", delegationId: processChildDelegationId }
      : fresh
        ? { mode: "standalone" }
        : persisted;
    mode = state.mode;
    if (fresh && !processChildDelegationId) pi.appendEntry(ROLE_ENTRY, state);
    const effectiveCatalog = loadCatalog(ctx);
    if (mode === "child") {
      const delegationId = processChildDelegationId ?? state.delegationId;
      if (!delegationId) throw new Error("Child session is missing its durable delegation identity.");
      childDelegation = await orchestrator.child(delegationId);
      currentAgent = definitionFromSnapshot(childDelegation.agent);
      roleState?.set(currentAgent.name);
      verifyChildEnvironment(childDelegation);
      if (reconstructSubagentState(ctx.sessionManager.getEntries()).mode !== "child") {
        state = { mode: "child", agentName: currentAgent.name, delegationId };
        pi.appendEntry(ROLE_ENTRY, state);
      }
      await orchestrator.attachChildSession(delegationId, {
        id: ctx.sessionManager.getSessionId(),
        file: ctx.sessionManager.getSessionFile(),
      });
      applyTools(currentAgent);
      return;
    }
    if (mode === "root") {
      const root = state.agentName
        ? effectiveCatalog.byName.get(state.agentName)
        : effectiveCatalog.root;
      if (!root || !root.root || !await activateAgent(root, ctx)) {
        mode = "standalone";
        roleState?.set();
        state = { mode: "standalone" };
        capabilities?.disable("subagents", "user");
        pi.appendEntry(ROLE_ENTRY, state);
      }
      return;
    }
    currentAgent = undefined;
    roleState?.set();
    applyTools();
  });

  pi.on("before_agent_start", async (event) => {
    const instructions = loadInstructions();
    if (mode === "child" && childDelegation?.id) {
      childDelegation = await orchestrator.child(childDelegation.id);
    }
    const children = currentAgent && catalog
      ? currentAgent.allowedChildren.map((name) => catalog!.byName.get(name)).filter(isDefinition)
      : [];
    return {
      systemPrompt: composePiTaiInstructions({
        basePrompt: event.systemPrompt,
        mode,
        agentName: currentAgent?.name,
        systemInstructions: instructions.system,
        ...(mode === "root" && currentAgent ? { roleInstructions: currentAgent.systemPrompt } : {}),
        availableChildren: children.map(({ name, description }) => ({ name, description })),
        ...(childDelegation ? {
          delegation: {
            id: childDelegation.id,
            parentSessionId: childDelegation.parentSessionId,
            cwd: childDelegation.cwd,
          },
        } : {}),
      }),
    };
  });

  pi.on("turn_start", () => {
    spawnSeenThisTurn = false;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!currentAgent?.tools.includes("subagent")) return;
    if (event.toolName === "subagent") {
      spawnSeenThisTurn = true;
      return;
    }
    if (parentTools.has(event.toolName) || CHILD_PROTOCOL_TOOL_NAMES.includes(event.toolName as never)) return;
    if (spawnSeenThisTurn || entrySpawnsChild(ctx.sessionManager.getLeafEntry?.())) {
      return {
        block: true,
        reason: "Parent work cannot run in the same turn as subagent. Delegate the complete task, then wait or inspect child status.",
      };
    }
    const activeChildren = (await orchestrator.children(ctx.sessionManager.getSessionId()))
      .filter((record) => !isResolvedDelegation(record));
    if (activeChildren.length > 0) {
      return {
        block: true,
        reason: `Parent work is paused while ${activeChildren.length} child delegation(s) are active. Use child controls instead of duplicating their work.`,
      };
    }
  });

  pi.on("session_shutdown", async (event) => {
    if (event.reason === "quit" && mode === "child" && childDelegation?.id) {
      await orchestrator.cleanupChildControl(childDelegation.id);
    }
  });

  pi.registerCommand("cap:subagents", {
    description: "Enable, inspect, or disable declarative subagents",
    handler: async (args, ctx) => {
      const command = parseSubagentsCommand(args);
      if (!command) {
        ctx.ui.notify("Usage: /cap:subagents [on|off|status]", "warning");
        return;
      }
      if (command === "status") {
        const children = await orchestrator.children(ctx.sessionManager.getSessionId());
        const unresolved = children.filter((record) => !isResolvedDelegation(record)).length;
        ctx.ui.notify(
          `Subagents: ${mode}${currentAgent ? ` (${currentAgent.name})` : ""}; ${children.length} children, ${unresolved} unresolved.`,
          "info",
        );
        return;
      }
      if (mode === "child") {
        ctx.ui.notify("Delegated children cannot change their root role.", "error");
        return;
      }
      if (command === "on") {
        if (mode === "root") {
          ctx.ui.notify(`Subagents already enabled as ${currentAgent?.name ?? "root"}.`, "info");
          return;
        }
        const root = loadCatalog(ctx).root;
        const previous: PersistedSubagentState["previous"] = {
          ...(ctx.model ? { provider: ctx.model.provider, model: ctx.model.id } : {}),
          effort: pi.getThinkingLevel(),
          tools: pi.getActiveTools(),
        };
        if (!await activateAgent(root, ctx)) return;
        await capabilities?.enable("subagents", { owner: "user", exposure: "model-tools" });
        mode = "root";
        state = { mode, agentName: root.name, previous };
        pi.appendEntry(ROLE_ENTRY, state);
        applyTools(root);
        ctx.ui.notify(`Subagents enabled with root agent "${root.name}".`, "info");
        return;
      }
      const unresolved = (await orchestrator.children(ctx.sessionManager.getSessionId()))
        .filter((record) => !isResolvedDelegation(record));
      if (unresolved.length > 0) {
        ctx.ui.notify(`Cannot disable subagents with ${unresolved.length} unresolved children.`, "error");
        return;
      }
      const previous = state.previous;
      if (previous?.provider && previous.model) {
        const model = ctx.modelRegistry.find(previous.provider, previous.model);
        if (model) await pi.setModel(model);
      }
      if (previous) {
        pi.setThinkingLevel(previous.effort as Parameters<typeof pi.setThinkingLevel>[0]);
        pi.setActiveTools(previous.tools);
      } else {
        applyTools();
      }
      mode = "standalone";
      currentAgent = undefined;
      roleState?.set();
      state = { mode };
      capabilities?.disable("subagents", "user");
      pi.appendEntry(ROLE_ENTRY, state);
      ctx.ui.notify("Subagents disabled for this session.", "info");
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Spawn one isolated declarative child with no parent conversation history. The task packet must be self-contained.",
    promptSnippet: "Delegate a self-contained task packet to an allowed specialized child",
    promptGuidelines: [
      "Use subagent only with a self-contained task packet; children share cwd but receive no conversation history.",
      "After spawning children, use wait_for_children or child_status instead of duplicating their assignments.",
    ],
    parameters: Type.Object({
      agent: Type.String({ description: "Allowed child agent name" }),
      task: taskPacketSchema(),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const caller = requireOrchestrator(currentAgent);
      const effectiveCatalog = loadCatalog(ctx);
      const target = effectiveCatalog.byName.get(params.agent);
      if (!target) throw new Error(`Unknown agent: ${params.agent}`);
      if (!caller.allowedChildren.includes(target.name)) {
        throw new Error(`Agent "${caller.name}" cannot create "${target.name}".`);
      }
      validateAgentTools(target, availableToolNames());
      const record = await orchestrator.spawnChild({
        task: params.task,
        agent: target,
        caller,
        parentCwd: ctx.cwd,
        parentSessionId: ctx.sessionManager.getSessionId(),
        ...(childDelegation ? { parentDelegationId: childDelegation.id } : {}),
      });
      return result(`Spawned ${record.agent.name} child ${record.id} in ${record.cwd}.`, record);
    },
  });

  pi.registerTool({
    name: "message_child",
    label: "Message Child",
    description: "Steer a running direct child or queue a follow-up instruction.",
    parameters: Type.Object({
      delegationId: Type.String(),
      message: Type.String({ minLength: 1, maxLength: 16_000 }),
      delivery: Type.Optional(StringEnum(["steer", "followUp"] as const)),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireOrchestrator(currentAgent);
      await requireDirectChild(orchestrator, params.delegationId, ctx.sessionManager.getSessionId());
      const record = await orchestrator.message(params.delegationId, params.message, params.delivery ?? "steer");
      return result(`Sent ${params.delivery ?? "steer"} message to ${record.id}.`, record);
    },
  });

  pi.registerTool({
    name: "wait_for_children",
    label: "Wait for Children",
    description: "Wait for the next direct-child completion or question, or for all selected children.",
    promptSnippet: "Wait without model churn for the next child completion/question or all children",
    parameters: Type.Object({
      delegationIds: Type.Optional(Type.Array(Type.String())),
      until: Type.Optional(StringEnum(["next", "all"] as const)),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      requireOrchestrator(currentAgent);
      const records = await orchestrator.wait(ctx.sessionManager.getSessionId(), {
        signal,
        ...(params.delegationIds ? { childIds: params.delegationIds } : {}),
        until: params.until ?? "next",
        onProgress(current) {
          onUpdate?.(result(`Waiting: ${current.filter(isResolvedDelegation).length}/${current.length} resolved.`, current));
        },
      });
      return result(formatRecords(records), records);
    },
  });

  pi.registerTool({
    name: "child_status",
    label: "Child Status",
    description: "Inspect one direct child or list all direct children without consuming completions.",
    parameters: Type.Object({ delegationId: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireOrchestrator(currentAgent);
      const records = params.delegationId
        ? [await requireDirectChild(orchestrator, params.delegationId, ctx.sessionManager.getSessionId())]
        : await orchestrator.children(ctx.sessionManager.getSessionId());
      return result(formatRecords(records), records);
    },
  });

  pi.registerTool({
    name: "respond_to_child",
    label: "Respond to Child",
    description: "Answer the currently outstanding correlated question from a direct child.",
    parameters: Type.Object({
      delegationId: Type.String(),
      questionId: Type.String(),
      response: Type.String({ minLength: 1, maxLength: 16_000 }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireOrchestrator(currentAgent);
      await requireDirectChild(orchestrator, params.delegationId, ctx.sessionManager.getSessionId());
      const record = await orchestrator.respond(params.delegationId, params.questionId, params.response);
      return result(`Answered ${params.questionId} for ${record.id}.`, record);
    },
  });

  pi.registerTool({
    name: "abandon_child",
    label: "Abandon Child",
    description: "Stop a direct child without modifying or cleaning the shared working directory.",
    parameters: Type.Object({ delegationId: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireOrchestrator(currentAgent);
      await requireDirectChild(orchestrator, params.delegationId, ctx.sessionManager.getSessionId());
      const record = await orchestrator.abandon(params.delegationId);
      return result(`Abandoned child ${record.id}; shared files were left untouched.`, record);
    },
  });

  pi.registerTool({
    name: "ask_parent",
    label: "Ask Parent",
    description: "Pause for a correlated parent decision when configured uncertainty handling is ask-parent.",
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 8_000 }),
      options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }))),
      recommendation: Type.Optional(Type.String({ maxLength: 4_000 })),
      consequences: Type.Optional(Type.Array(Type.String({ maxLength: 2_000 }))),
    }),
    async execute(_id, params) {
      if (mode !== "child" || !childDelegation) throw new Error("ask_parent requires a delegated child.");
      if (childDelegation.task.uncertaintyHandling !== "ask-parent") {
        throw new Error(`Task uncertainty handling is ${childDelegation.task.uncertaintyHandling}, not ask-parent.`);
      }
      const record = await orchestrator.askParent(childDelegation.id, params);
      childDelegation = record;
      return result(
        `Waiting for parent response to ${record.execution.phase === "awaiting_parent" ? record.execution.question.id : "question"}.`,
        record,
      );
    },
  });

  pi.registerTool({
    name: "report_to_parent",
    label: "Report to Parent",
    description: "Resolve the delegated task, wake its direct parent, and terminate the child run.",
    parameters: Type.Object({
      outcome: StringEnum(["completed", "blocked", "failed", "cancelled"] as const),
      summary: Type.String(),
      validation: Type.Optional(Type.Array(Type.String())),
      changedFiles: Type.Optional(Type.Array(Type.String())),
      concerns: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (mode !== "child" || !childDelegation) throw new Error("report_to_parent requires a delegated child.");
      const unresolved = (await orchestrator.children(ctx.sessionManager.getSessionId()))
        .filter((record) => !isResolvedDelegation(record));
      if (unresolved.length > 0) throw new Error(`Resolve ${unresolved.length} child delegation(s) before reporting.`);
      const record = await orchestrator.report(childDelegation.id, params);
      childDelegation = record;
      ctx.shutdown();
      return { ...result(`Reported ${record.execution.phase} to parent.`, record), terminate: true };
    },
  });
}

function taskPacketSchema() {
  return Type.Object({
    objective: Type.String({ minLength: 1, maxLength: 16_000 }),
    context: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4_000 }), { maxItems: 64 })),
    resources: Type.Optional(Type.Array(Type.Object({
      type: StringEnum(TASK_RESOURCE_TYPES),
      value: Type.String({ minLength: 1, maxLength: 8_000 }),
      reason: Type.Optional(Type.String({ maxLength: 2_000 })),
    }), { maxItems: 64 })),
    constraints: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4_000 }), { maxItems: 64 })),
    acceptanceCriteria: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4_000 }), { maxItems: 64 })),
    expectedOutput: Type.Optional(Type.String({ maxLength: 8_000 })),
    uncertaintyHandling: Type.Optional(StringEnum(["best-effort", "block", "ask-parent"] as const)),
  });
}

function definitionFromSnapshot(snapshot: AgentDefinitionSnapshot): AgentDefinition {
  return {
    ...snapshot,
    source: snapshot.source === "legacy" ? "user" : snapshot.source,
  };
}

function verifyChildEnvironment(record: DelegationRecord): void {
  const expectedAgent = process.env[AGENT_ENV];
  if (expectedAgent && expectedAgent !== record.agent.name) {
    throw new Error(`Child agent mismatch: expected ${expectedAgent}, record names ${record.agent.name}.`);
  }
  const allowed = process.env[ALLOWED_ENV];
  if (allowed) {
    const parsed = JSON.parse(allowed) as unknown;
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
      throw new Error("Invalid child allowlist environment.");
    }
    if (JSON.stringify(parsed) !== JSON.stringify(record.agent.allowedChildren)) {
      throw new Error("Child allowlist does not match the durable role snapshot.");
    }
  }
}

function requireOrchestrator(agent: AgentDefinition | undefined): AgentDefinition {
  if (!agent?.tools.includes("subagent")) throw new Error("Current agent cannot orchestrate children.");
  return agent;
}

async function requireDirectChild(
  orchestrator: SubagentOrchestrator,
  id: string,
  parentSessionId: string,
): Promise<DelegationRecord> {
  const record = await orchestrator.child(id);
  if (record.parentSessionId !== parentSessionId) {
    throw new Error(`Delegation ${id} does not belong to this direct parent.`);
  }
  return record;
}

function entrySpawnsChild(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const candidate = entry as { type?: unknown; message?: { role?: unknown; content?: unknown } };
  return candidate.type === "message"
    && candidate.message?.role === "assistant"
    && Array.isArray(candidate.message.content)
    && candidate.message.content.some((part) => Boolean(
      part && typeof part === "object" && !Array.isArray(part)
      && (part as { type?: unknown }).type === "toolCall"
      && (part as { name?: unknown }).name === "subagent",
    ));
}

function formatRecords(records: readonly DelegationRecord[]): string {
  if (records.length === 0) return "No matching child delegations.";
  return records.map((record) => {
    if (record.execution.phase === "awaiting_parent") {
      return `${record.id} (${record.agent.name}): awaiting parent — ${record.execution.question.question} [${record.execution.question.id}]`;
    }
    const report = childReport(record);
    return `${record.id} (${record.agent.name}): ${record.execution.phase}${report ? ` — ${report.summary}` : ""}`;
  }).join("\n");
}

function result(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function isDefinition(value: AgentDefinition | undefined): value is AgentDefinition {
  return Boolean(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
