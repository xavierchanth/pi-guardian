import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key, Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { SessionCapabilityController } from "../capabilities/controller.ts";
import type { WorkspacePort } from "../workspaces/domain.ts";
import { GitWorktreePort } from "../workspaces/git.ts";
import { JjWorkspacePort } from "../workspaces/jj.ts";
import { PreferredWorkspacePort } from "../workspaces/preferred.ts";
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
import {
  formatChildDetail,
  summarizeChildActivity,
  type ChildActivitySummary,
} from "./ui.ts";

const ROLE_ENTRY = "pi-tai-subagent-role";
const CHILD_ENV = "PI_TAI_DELEGATION_ID";
const STORE_ENV = "PI_TAI_DELEGATION_STORE";
const AGENT_ENV = "PI_TAI_AGENT_NAME";
const ALLOWED_ENV = "PI_TAI_ALLOWED_CHILDREN";
const CHILD_WIDGET_KEY = "pi-tai-subagents";
const CHILD_WIDGET_INTERVAL_MS = 500;

export interface SubagentDependencies {
  store?: DelegationStore;
  orchestrator?: SubagentOrchestrator;
  loadInstructions?: InstructionLoader;
  discoverAgents?: (ctx: ExtensionContext) => AgentCatalog;
  childDelegationId?: string;
  capabilities?: SessionCapabilityController;
  workspace?: WorkspacePort;
  agentDir?: string;
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
  const workspace = dependencies.workspace ?? new PreferredWorkspacePort(
    new JjWorkspacePort(),
    new GitWorktreePort(join(agentDir, "pi-tai", "workspaces", "git")),
  );
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
  let childWidgetTimer: ReturnType<typeof setInterval> | undefined;
  let childWidgetRefresh: Promise<void> | undefined;
  let childWidgetGeneration = 0;

  const loadCatalog = (ctx: ExtensionContext): AgentCatalog => {
    catalog = discover(ctx);
    return catalog;
  };

  const isRootMode = (): boolean => mode === "root";

  const refreshChildWidget = (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui" || !isRootMode()) return Promise.resolve();
    if (childWidgetRefresh) return childWidgetRefresh;
    const generation = childWidgetGeneration;
    childWidgetRefresh = (async () => {
      const records = (await orchestrator.children(ctx.sessionManager.getSessionId()))
        .filter((record) => !isResolvedDelegation(record) || !record.parentCollectedAt);
      if (records.length === 0 || !isRootMode() || generation !== childWidgetGeneration) {
        ctx.ui.setWidget(CHILD_WIDGET_KEY, undefined);
        return;
      }
      const summaries = await Promise.all(records.map(summarizeChildActivity));
      if (!isRootMode() || generation !== childWidgetGeneration) return;
      ctx.ui.setWidget(
        CHILD_WIDGET_KEY,
        (_tui, theme) => ({
          render(width: number) {
            return summaries.flatMap(({ record, activity }) => [
              truncateToWidth(
                `${theme.fg("accent", "subagent")} · ${theme.fg("muted", record.agent.name)} · ${singleDisplayLine(record.task.objective)}`,
                width,
                "…",
              ),
              truncateToWidth(
                `  ${theme.fg(childPhaseColor(record), record.execution.phase)} · ${theme.fg("dim", singleDisplayLine(activity))}`,
                width,
                "…",
              ),
            ]);
          },
          invalidate() {},
        }),
        { placement: "belowEditor" },
      );
    })().catch(() => undefined).finally(() => {
      childWidgetRefresh = undefined;
    });
    return childWidgetRefresh;
  };

  const stopChildWidget = (ctx?: ExtensionContext) => {
    childWidgetGeneration += 1;
    if (childWidgetTimer) clearInterval(childWidgetTimer);
    childWidgetTimer = undefined;
    ctx?.ui.setWidget(CHILD_WIDGET_KEY, undefined);
  };

  const startChildWidget = (ctx: ExtensionContext) => {
    stopChildWidget(ctx);
    if (ctx.mode !== "tui" || mode !== "root") return;
    void refreshChildWidget(ctx);
    childWidgetTimer = setInterval(() => void refreshChildWidget(ctx), CHILD_WIDGET_INTERVAL_MS);
    childWidgetTimer.unref();
  };

  const showSubagentView = async (requestedId: string | undefined, ctx: ExtensionContext) => {
    const records = (await orchestrator.children(ctx.sessionManager.getSessionId()))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    if (records.length === 0) {
      ctx.ui.notify("No child delegations for this session.", "info");
      return;
    }
    let selected = requestedId
      ? records.find((record) => record.id === requestedId)
      : undefined;
    if (requestedId && !selected) {
      ctx.ui.notify(`Unknown direct child delegation: ${requestedId}`, "error");
      return;
    }
    if (!selected && ctx.mode === "tui") {
      const choices = records.map(
        (record) => `${record.id} · ${record.agent.name} · ${record.execution.phase} · ${record.task.objective}`,
      );
      const choice = await ctx.ui.select("Inspect subagent", choices);
      selected = choice ? records[choices.indexOf(choice)] : undefined;
    }
    selected ??= records[0];
    if (!selected) return;
    const detail = formatChildDetail(await summarizeChildActivity(selected));
    if (ctx.mode !== "tui") {
      ctx.ui.notify(detail, "info");
      return;
    }
    await ctx.ui.custom<void>((_tui, _theme, _keybindings, done) => {
      const text = new Text(`${detail}\n\nEsc, Enter, or q to close`, 1, 1);
      return {
        render: (width: number) => text.render(width),
        invalidate: () => text.invalidate(),
        handleInput(data: string) {
          if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q") done();
        },
      };
    }, {
      overlay: true,
      overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center", margin: 1 },
    });
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
    applyTools(agent);
    return true;
  };

  const disableSubagents = async (
    ctx: ExtensionContext,
    force: boolean,
  ): Promise<void> => {
    if (mode === "child") {
      ctx.ui.notify("Delegated children cannot change their root role.", "error");
      return;
    }
    const unresolved = (await orchestrator.children(ctx.sessionManager.getSessionId()))
      .filter((record) => !isResolvedDelegation(record));
    if (unresolved.length > 0 && !force) {
      ctx.ui.notify(
        `Cannot disable subagents with ${unresolved.length} unresolved children. Use force-off to terminate them.`,
        "error",
      );
      return;
    }
    const abandoned = force
      ? await orchestrator.forceAbandonChildren(ctx.sessionManager.getSessionId())
      : [];
    if (mode === "root") {
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
      state = { mode };
      capabilities?.disable("subagents", "user");
      pi.appendEntry(ROLE_ENTRY, state);
    }
    stopChildWidget(ctx);
    ctx.ui.notify(
      force
        ? `Subagents disabled; terminated ${abandoned.length} unresolved child process(es).`
        : "Subagents disabled for this session.",
      "info",
    );
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
      stopChildWidget(ctx);
      return;
    }
    if (mode === "root") {
      const root = state.agentName
        ? effectiveCatalog.byName.get(state.agentName)
        : effectiveCatalog.root;
      if (!root || !root.root || !await activateAgent(root, ctx)) {
        mode = "standalone";
        state = { mode: "standalone" };
        capabilities?.disable("subagents", "user");
        pi.appendEntry(ROLE_ENTRY, state);
      }
      startChildWidget(ctx);
      return;
    }
    currentAgent = undefined;
    applyTools();
    stopChildWidget(ctx);
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

  pi.on("session_shutdown", async (event, ctx) => {
    stopChildWidget(ctx);
    if (event.reason === "quit" && mode === "child" && childDelegation?.id) {
      await orchestrator.cleanupChildControl(childDelegation.id);
    }
  });

  pi.registerCommand("subagents", {
    description: "Toggle, configure, or inspect declarative subagents",
    handler: async (args, ctx) => {
      const command = parseSubagentsCommand(args);
      if (!command) {
        ctx.ui.notify("Usage: /subagents [on|off|force-off|status|list [delegation-id]]", "warning");
        return;
      }
      if (command.action === "list") {
        await showSubagentView(command.delegationId, ctx);
        return;
      }
      if (command.action === "status") {
        const children = await orchestrator.children(ctx.sessionManager.getSessionId());
        const unresolved = children.filter((record) => !isResolvedDelegation(record)).length;
        ctx.ui.notify(
          `Subagents: ${mode}${currentAgent ? ` (${currentAgent.name})` : ""}; ${children.length} children, ${unresolved} unresolved.`,
          "info",
        );
        return;
      }
      if (command.action === "off" || command.action === "force-off") {
        await disableSubagents(ctx, command.action === "force-off");
        return;
      }
      if (command.action === "toggle" && mode === "root") {
        await disableSubagents(ctx, false);
        return;
      }
      if (mode === "child") {
        ctx.ui.notify("Delegated children cannot change their root role.", "error");
        return;
      }
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
      startChildWidget(ctx);
      ctx.ui.notify(`Subagents enabled with root agent "${root.name}".`, "info");
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Spawn one isolated declarative child with no parent conversation history. The task packet must be self-contained.",
    promptSnippet: "Delegate a self-contained task packet to an allowed specialized child",
    promptGuidelines: [
      "Use subagent only with a self-contained task packet; children share cwd but receive no conversation history.",
      "After spawning children, continue independent parent work when useful, but do not duplicate their assignments; use wait_for_children or child_status when you need their results.",
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
      await refreshChildWidget(ctx);
      return result(`Spawned ${record.agent.name} child ${record.id} in ${record.cwd}.`, record);
    },
  });

  pi.registerTool({
    name: "planner_workspace",
    label: "Planner Workspace",
    description: "Create an isolated preferred workspace (JJ before Git) and launch one planner there. Only the root thinker may call this tool.",
    promptSnippet: "Launch a planner for a substantial subtask in an isolated workspace",
    promptGuidelines: [
      "Use planner_workspace only from the root thinker, only for a substantial self-contained planner task, and only when workspace isolation is useful.",
      "planner_workspace may branch from source @- while source @ contains ongoing work; it never moves or rewrites source files during creation and never falls back from a partially failed JJ mutation to Git.",
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Optional lowercase workspace name" })),
      task: taskPacketSchema(),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const caller = requireWorkspaceThinker(currentAgent);
      const effectiveCatalog = loadCatalog(ctx);
      const planner = effectiveCatalog.byName.get("planner");
      if (!planner) throw new Error("The agent catalog has no planner definition.");
      if (!caller.allowedChildren.includes(planner.name)) {
        throw new Error(`Agent "${caller.name}" cannot create "${planner.name}".`);
      }
      validateAgentTools(planner, availableToolNames());
      const name = plannerWorkspaceName(params.name, params.task.objective);
      const attachment = await workspace.create({
        cwd: ctx.cwd,
        name,
        purpose: "delegation",
      });
      const record = await orchestrator.spawnChild({
        task: params.task,
        agent: planner,
        caller,
        parentCwd: attachment.path,
        parentSessionId: ctx.sessionManager.getSessionId(),
        workspace: attachment,
      });
      await refreshChildWidget(ctx);
      return result(
        `Spawned planner ${record.id} in ${attachment.backend} workspace ${attachment.path}.`,
        record,
      );
    },
  });

  pi.registerTool({
    name: "integrate_planner_workspace",
    label: "Integrate Planner Workspace",
    description: "Integrate one completed direct planner workspace into the thinker workspace. Any uncertainty or conflict stops for user intervention.",
    parameters: Type.Object({ delegationId: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireWorkspaceThinker(currentAgent);
      const child = await requireDirectChild(orchestrator, params.delegationId, ctx.sessionManager.getSessionId());
      requirePlannerWorkspace(child);
      const record = await orchestrator.integrateWorkspace(child.id, workspace);
      await refreshChildWidget(ctx);
      return result(`Integrated planner workspace for ${record.id}; cleanup remains explicit.`, record);
    },
  });

  pi.registerTool({
    name: "cleanup_planner_workspace",
    label: "Cleanup Planner Workspace",
    description: "Forget and remove a planner workspace only after its integration was recorded as clean.",
    parameters: Type.Object({ delegationId: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireWorkspaceThinker(currentAgent);
      const child = await requireDirectChild(orchestrator, params.delegationId, ctx.sessionManager.getSessionId());
      requirePlannerWorkspace(child);
      const record = await orchestrator.cleanupWorkspace(child.id, workspace);
      await refreshChildWidget(ctx);
      return result(`Cleaned planner workspace for ${record.id}.`, record);
    },
  });

  pi.registerTool({
    name: "message_child",
    label: "Message Child",
    description: "Steer a running direct child (including status-then-continue) or queue a subsequent instruction with followUp.",
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
      await refreshChildWidget(ctx);
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

function requireWorkspaceThinker(agent: AgentDefinition | undefined): AgentDefinition {
  if (!agent?.root || !agent.tools.includes("planner_workspace")) {
    throw new Error("Only the root thinker can manage planner workspaces.");
  }
  return agent;
}

function requirePlannerWorkspace(record: DelegationRecord): void {
  if (record.agent.name !== "planner" || !record.workspace) {
    throw new Error(`Delegation ${record.id} is not an isolated planner workspace.`);
  }
}

function plannerWorkspaceName(requested: string | undefined, objective: string): string {
  if (requested) {
    const normalized = requested.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(normalized)) {
      throw new Error("Workspace name must contain lowercase letters, numbers, and hyphens only.");
    }
    return normalized;
  }
  const slug = objective.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24) || "task";
  return `planner-${slug}-${randomUUID().slice(0, 8)}`;
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

function singleDisplayLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function childPhaseColor(record: DelegationRecord): "success" | "error" | "warning" | "muted" {
  switch (record.execution.phase) {
    case "completed": return "success";
    case "failed":
    case "cancelled":
    case "abandoned": return "error";
    case "awaiting_parent": return "warning";
    case "created":
    case "running":
    case "blocked": return "muted";
  }
}

function isDefinition(value: AgentDefinition | undefined): value is AgentDefinition {
  return Boolean(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
