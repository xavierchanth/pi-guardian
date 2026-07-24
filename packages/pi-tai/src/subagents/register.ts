import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key, Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { SessionCapabilityController } from "../capabilities/controller.ts";
import type { PiTaiConfigService } from "../config/register.ts";
import { PrivateChildSessionFactory } from "../concurrency/child-session.ts";
import { ChildContextCoordinator } from "../concurrency/coordinator.ts";
import { FileChildContextStore, type PersistedChildContextV4 } from "../concurrency/persistence.ts";
import type { WorkspaceAttachment, WorkspacePort } from "../workspaces/domain.ts";
import { JjWorkspacePort } from "../workspaces/jj.ts";
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
  snapshotAgentDefinition,
  type AgentDefinitionSnapshot,
  type DelegationRecord,
  type DelegationStore,
} from "./store.ts";
import { normalizeTaskPacket, TASK_RESOURCE_TYPES } from "./task.ts";
import {
  delegationTree,
  delegationTreePrefix,
  finalVisibleAssistantText,
  formatChildDetail,
  formatUsage,
  readTranscript,
  summarizeChildActivity,
  treeUsage,
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
  config?: PiTaiConfigService;
  coordinator?: ChildContextCoordinator;
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
  const stateRoot = dirname(storeRoot);
  const coordinator = dependencies.coordinator ?? (dependencies.config
    ? new ChildContextCoordinator({
        store: new FileChildContextStore(join(stateRoot, "context-records")),
        sessionFactory: new PrivateChildSessionFactory({ config: dependencies.config }),
        stateRoot,
        agentDir,
      })
    : undefined);
  const capabilities = dependencies.capabilities;
  const workspace = dependencies.workspace ?? new JjWorkspacePort();
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

  const spawnManagedChild = async (input: {
    task: Parameters<SubagentOrchestrator["spawnChild"]>[0]["task"];
    agent: AgentDefinition;
    caller: AgentDefinition;
    parentCwd: string;
    parentSessionId: string;
    parentDelegationId?: string;
    workspace?: WorkspaceAttachment;
    modelRegistry: ExtensionContext["modelRegistry"];
  }): Promise<DelegationRecord> => {
    if (!coordinator) return orchestrator.spawnChild(input);
    const task = normalizeTaskPacket(input.task, input.agent.uncertaintyHandling);
    const agent = snapshotAgentDefinition(input.agent);
    const caller = snapshotAgentDefinition(input.caller);
    const context = await coordinator.spawn({
      rootSessionId: childDelegation?.parentSessionId ?? input.parentSessionId,
      ...(input.parentDelegationId ? { parentContextId: input.parentDelegationId } : {}),
      cwd: input.parentCwd,
      task,
      agent,
      caller,
      modelRegistry: input.modelRegistry,
      ...(input.workspace ? { workspace: input.workspace } : {}),
      extensions: (contextId) => [{
        name: `pi-tai-child-runtime-${contextId}`,
        factory: (childPi: ExtensionAPI) => registerSubagents(childPi, {
          store,
          orchestrator,
          coordinator,
          ...(dependencies.config ? { config: dependencies.config } : {}),
          loadInstructions,
          discoverAgents: discover,
          childDelegationId: contextId,
          workspace,
          agentDir,
        }),
      }],
      onPersisted: async (record: PersistedChildContextV4) => {
        const legacy: DelegationRecord = {
          version: 3,
          id: record.contextId,
          parentSessionId: input.parentSessionId,
          ...(input.parentDelegationId ? { parentDelegationId: input.parentDelegationId } : {}),
          cwd: record.cwd,
          task,
          agent,
          execution: { phase: "created" },
          ...(input.workspace ? { workspace: { phase: "active", attachment: input.workspace } } : {}),
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        };
        await store.create(legacy);
      },
      onStarted: async (record: PersistedChildContextV4) => {
        if (record.execution.phase !== "running") return;
        const { sessionId, sessionFile } = record.execution;
        await store.update(record.contextId, (current) => ({
          ...current,
          execution: { phase: "running" },
          childSessionId: sessionId,
          childSessionFile: sessionFile,
          updatedAt: record.updatedAt,
        }));
      },
    });
    return orchestrator.child(context.contextId);
  };

  const loadCatalog = (ctx: ExtensionContext): AgentCatalog => {
    catalog = discover(ctx);
    return catalog;
  };

  const isRootMode = (): boolean => mode === "root";

  const refreshChildWidget = (_ctx: ExtensionContext): Promise<void> => Promise.resolve();

  const stopChildWidget = (ctx?: ExtensionContext) => {
    childWidgetGeneration += 1;
    if (childWidgetTimer) clearInterval(childWidgetTimer);
    childWidgetTimer = undefined;
    ctx?.ui.setWidget(CHILD_WIDGET_KEY, undefined);
  };

  const startChildWidget = (ctx: ExtensionContext) => {
    // Child state is intentionally available only in explicit list/inspect/wait views.
    stopChildWidget(ctx);
  };

  const showInlinePane = async (
    ctx: ExtensionContext,
    tabs: readonly { label: string; content: string; truncateLines?: boolean }[],
  ): Promise<void> => {
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      let tabIndex = 0;
      let offset = 0;
      let cachedWidth: number | undefined;
      let cachedTab: number | undefined;
      let bodyLines: string[] = [];
      const viewportRows = () => Math.max(6, Math.min(16, (process.stdout.rows ?? 32) - 12));
      const rebuild = (width: number) => {
        if (cachedWidth === width && cachedTab === tabIndex) return;
        const tab = tabs[tabIndex];
        bodyLines = tab?.truncateLines
          ? tab.content.split("\n").map((line) => truncateToWidth(` ${line}`, width, "…"))
          : new Text(tab?.content ?? "", 1, 0).render(width);
        cachedWidth = width;
        cachedTab = tabIndex;
        offset = Math.min(offset, Math.max(0, bodyLines.length - viewportRows()));
      };
      const move = (delta: number) => {
        const maximum = Math.max(0, bodyLines.length - viewportRows());
        offset = Math.max(0, Math.min(maximum, offset + delta));
        tui.requestRender();
      };
      return {
        render(width: number) {
          rebuild(width);
          const rows = viewportRows();
          const maximum = Math.max(0, bodyLines.length - rows);
          offset = Math.min(offset, maximum);
          const tabLine = tabs.map((tab, index) => index === tabIndex
            ? theme.fg("accent", `[${tab.label}]`)
            : theme.fg("muted", ` ${tab.label} `)).join(" ");
          const position = bodyLines.length > rows
            ? `${offset + 1}-${Math.min(bodyLines.length, offset + rows)}/${bodyLines.length}`
            : `${bodyLines.length} lines`;
          return [
            ...new Text(tabLine, 1, 1).render(width),
            ...bodyLines.slice(offset, offset + rows),
            ...new Text(theme.fg("dim", `↑/↓ scroll · PgUp/PgDn page · Home/g top · End/G bottom${tabs.length > 1 ? " · ←/→ tabs" : ""} · Esc close · ${position}`), 1, 1).render(width),
          ];
        },
        invalidate() {
          cachedWidth = undefined;
          cachedTab = undefined;
        },
        handleInput(data: string) {
          if (matchesKey(data, Key.escape)) return done();
          if (matchesKey(data, Key.up)) return move(-1);
          if (matchesKey(data, Key.down)) return move(1);
          if (matchesKey(data, Key.pageUp)) return move(-viewportRows());
          if (matchesKey(data, Key.pageDown)) return move(viewportRows());
          if (matchesKey(data, Key.home) || data === "g") { offset = 0; return tui.requestRender(); }
          if (matchesKey(data, Key.end) || data === "G") { offset = Math.max(0, bodyLines.length - viewportRows()); return tui.requestRender(); }
          if (tabs.length > 1 && (matchesKey(data, Key.left) || matchesKey(data, Key.right))) {
            tabIndex = matchesKey(data, Key.left)
              ? (tabIndex - 1 + tabs.length) % tabs.length
              : (tabIndex + 1) % tabs.length;
            offset = 0;
            cachedTab = undefined;
            tui.requestRender();
          }
        },
      };
    });
  };

  const showSubagentView = async (requestedId: string | undefined, ctx: ExtensionContext) => {
    const allRecords = await orchestrator.all();
    const records = delegationTree(allRecords, ctx.sessionManager.getSessionId());
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
      const choiceWidth = Math.max(24, (process.stdout.columns ?? 80) - 8);
      const choices = records.map((record) => truncateToWidth(
        `${delegationTreePrefix(record, allRecords, records)}${record.id} · ${record.agent.name} · ${record.execution.phase} · ${singleDisplayLine(record.task.objective)}`,
        choiceWidth,
        "…",
      ));
      const choice = await ctx.ui.select("Inspect subagent", choices);
      selected = choice ? records[choices.indexOf(choice)] : undefined;
    }
    if (!selected && ctx.mode !== "tui") selected = records[0];
    if (!selected) return;
    const transcript = selected.childLogPath ? await readTranscript(selected.childLogPath) : [];
    const usage = await treeUsage(selected, allRecords);
    const detail = `${formatChildDetail(await summarizeChildActivity(selected))}\n\nTREE USAGE\n${formatUsage(usage)}${transcript.length ? `\n\nTHREAD\n${transcript.map((entry) => `${entry.kind.toUpperCase()}\n${entry.text}`).join("\n\n")}` : ""}`;
    if (ctx.mode !== "tui") {
      ctx.ui.notify(detail, "info");
      return;
    }
    await showInlinePane(ctx, [{ label: `Inspect · ${selected.agent.name} · ${selected.id}`, content: detail }]);
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

  let settledAssistantText: string | undefined;
  pi.on("agent_end", (event) => {
    if (mode === "child") settledAssistantText = finalVisibleAssistantText(event.messages);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if ((mode === "root" || mode === "child") && currentAgent?.tools.includes("subagent")) {
      const outstanding = (await orchestrator.children(ctx.sessionManager.getSessionId()))
        .filter((record) => !isResolvedDelegation(record) || !record.parentCollectedAt);
      if (outstanding.length > 0) {
        pi.sendUserMessage(
          `You still own ${outstanding.length} unresolved or uncollected direct child result(s). Continue the orchestration loop now: handle questions and call wait_for_children repeatedly until all are resolved and collected.`,
        );
        return;
      }
    }
    if (mode !== "child" || !childDelegation) return;
    childDelegation = await orchestrator.settle(
      childDelegation.id,
      (settledAssistantText ?? "Child agent settled without an explicit report.").slice(0, 16_000),
    );
    if (isResolvedDelegation(childDelegation)) ctx.shutdown();
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
        ctx.ui.notify("Usage: /subagents [on|off|force-off|list|inspect [delegation-id]]", "warning");
        return;
      }
      if (command.action === "list") {
        const all = await orchestrator.all();
        const tree = delegationTree(all, ctx.sessionManager.getSessionId());
        const active = tree.filter((record) => !isResolvedDelegation(record));
        const inactive = tree.filter(isResolvedDelegation);
        const render = (records: readonly DelegationRecord[]) => records.length
          ? records.map((record) => `${delegationTreePrefix(record, all, records)}${record.agent.name} · ${record.execution.phase} · ${singleDisplayLine(record.task.objective)}`).join("\n")
          : "No delegations.";
        if (ctx.mode !== "tui") ctx.ui.notify(`Active (${active.length})\n${render(active)}\n\nInactive (${inactive.length})\n${render(inactive)}`, "info");
        else await showInlinePane(ctx, [
          { label: `Active (${active.length})`, content: render(active), truncateLines: true },
          { label: `Inactive (${inactive.length})`, content: render(inactive), truncateLines: true },
        ]);
        return;
      }
      if (command.action === "inspect") {
        await showSubagentView(command.delegationId, ctx);
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
      "Spawning is not completion. Continue independent parent work when useful, but do not duplicate child assignments.",
      "Before completing the delegated work, repeatedly call wait_for_children and handle each returned question or result until every direct child is resolved and every terminal result is collected; child_status does not collect results.",
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
      const record = await spawnManagedChild({
        task: params.task,
        agent: target,
        caller,
        parentCwd: ctx.cwd,
        parentSessionId: ctx.sessionManager.getSessionId(),
        ...(childDelegation ? { parentDelegationId: childDelegation.id } : {}),
        modelRegistry: ctx.modelRegistry,
      });
      await refreshChildWidget(ctx);
      return result(`Spawned ${record.agent.name} child ${record.id} in ${record.cwd}.`, record);
    },
  });

  pi.registerTool({
    name: "workspace_subagent",
    label: "Workspace Subagent",
    description: "Create an isolated JJ workspace and launch a planner or worker there. Only the root thinker may call this tool.",
    promptSnippet: "Launch a planner or worker in an isolated JJ workspace",
    promptGuidelines: [
      "Use workspace_subagent only from the root thinker and choose planner for decomposition or worker for bounded implementation.",
      "Launching a workspace child is not completion. Repeatedly call wait_for_children until its terminal result is collected, then call integrate_workspace.",
      "workspace_subagent branches from source @- while source @ may contain ongoing work; creation does not move or rewrite source files.",
    ],
    parameters: Type.Object({
      agent: StringEnum(["planner", "worker"] as const),
      name: Type.Optional(Type.String({ description: "Optional lowercase workspace name" })),
      task: taskPacketSchema(),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const caller = requireWorkspaceThinker(currentAgent);
      const effectiveCatalog = loadCatalog(ctx);
      const target = effectiveCatalog.byName.get(params.agent);
      if (!target) throw new Error(`The agent catalog has no ${params.agent} definition.`);
      if (!caller.allowedChildren.includes(target.name)) throw new Error(`Agent "${caller.name}" cannot create "${target.name}".`);
      validateAgentTools(target, availableToolNames());
      const name = workspaceName(params.name, params.task.objective, params.agent);
      const attachment = await workspace.create({ cwd: ctx.cwd, name, purpose: "delegation" });
      const record = await spawnManagedChild({
        task: params.task,
        agent: target,
        caller,
        parentCwd: attachment.path,
        parentSessionId: ctx.sessionManager.getSessionId(),
        workspace: attachment,
        modelRegistry: ctx.modelRegistry,
      });
      await refreshChildWidget(ctx);
      return result(`Spawned ${target.name} ${record.id} in JJ workspace ${attachment.path}.`, record);
    },
  });

  pi.registerTool({
    name: "integrate_workspace",
    label: "Integrate Workspace",
    description: "Update stale, detach and remove a completed child workspace, strip all empty delegated revisions, and insert the remaining JJ changes before source @.",
    promptGuidelines: [
      "After integrate_workspace, inspect and describe every change ID listed as undescribed before presenting the delegated work as complete.",
      "integrate_workspace permits a dirty source @ and preserves its Change ID and file content, while its commit ID and parent may be rewritten.",
    ],
    parameters: Type.Object({ delegationId: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireWorkspaceThinker(currentAgent);
      const child = await requireDirectChild(orchestrator, params.delegationId, ctx.sessionManager.getSessionId());
      requireDelegatedWorkspace(child);
      const record = await orchestrator.integrateWorkspace(child.id, workspace);
      await refreshChildWidget(ctx);
      const state = record.workspace?.phase === "integrated" ? record.workspace : undefined;
      const undescribed = state?.result.undescribedChangeIds ?? [];
      return result(
        `Integrated and removed workspace for ${record.id}. ${undescribed.length ? `Describe these changes before completion: ${undescribed.join(", ")}.` : "All retained changes are described."}`,
        record,
      );
    },
  });

  pi.registerTool({
    name: "describe_integrated_changes",
    label: "Describe Integrated Changes",
    description: "Apply thinker-chosen descriptions to retained changes from one integrated workspace and verify none of the supplied revisions remain undescribed.",
    promptGuidelines: [
      "After integrate_workspace reports undescribed changes, inspect them and call describe_integrated_changes with meaningful Conventional Commit descriptions before completion.",
    ],
    parameters: Type.Object({
      delegationId: Type.String(),
      changes: Type.Array(Type.Object({
        changeId: Type.String(),
        description: Type.String({ minLength: 1, maxLength: 1_000 }),
      }), { minItems: 1 }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireWorkspaceThinker(currentAgent);
      const child = await requireDirectChild(orchestrator, params.delegationId, ctx.sessionManager.getSessionId());
      requireDelegatedWorkspace(child);
      const record = await orchestrator.describeWorkspaceChanges(child.id, workspace, params.changes);
      const remaining = record.workspace?.phase === "integrated" ? record.workspace.result.undescribedChangeIds : [];
      return result(
        remaining.length ? `Descriptions applied; still undescribed: ${remaining.join(", ")}.` : "All retained integrated changes are described.",
        record,
      );
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
    description: "Wait-any for the next direct-child completion or question; call repeatedly to collect all delegated results.",
    promptSnippet: "Wait for one child event, then repeat until all direct-child results are collected",
    promptGuidelines: [
      "wait_for_children is wait-any: each call returns after one selected direct child completes or asks a question, not after all children finish.",
      "Handle a returned question, then call wait_for_children again. Keep calling until no owned direct child is unresolved and no terminal result is uncollected.",
      "Do not report completion, end delegated user-facing work, or call report_to_parent while a child result remains unresolved or uncollected.",
    ],
    parameters: Type.Object({
      delegationIds: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      requireOrchestrator(currentAgent);
      const records = await orchestrator.wait(ctx.sessionManager.getSessionId(), {
        signal,
        ...(params.delegationIds ? { childIds: params.delegationIds } : {}),
        async onProgress(current) {
          const all = await orchestrator.all();
          const directIds = new Set(current.map((record) => record.id));
          const byId = new Map(all.map((candidate) => [candidate.id, candidate]));
          const visible = delegationTree(all, ctx.sessionManager.getSessionId()).filter((record) => {
            let root = record;
            while (root.parentDelegationId && byId.has(root.parentDelegationId)) root = byId.get(root.parentDelegationId)!;
            return directIds.has(root.id) && !isResolvedDelegation(record);
          });
          const lines = visible.map((record) => `${delegationTreePrefix(record, all, visible)}${record.agent.name} · ${record.execution.phase} · ${singleDisplayLine(record.task.objective)}`);
          const text = `Waiting: ${current.filter(isResolvedDelegation).length}/${current.length} direct children resolved.\n${lines.join("\n")}`;
          onUpdate?.(result(text, { nodes: visible.map((record) => ({ id: record.id, parentDelegationId: record.parentDelegationId, phase: record.execution.phase })) }));
        },
      });
      if (records.length !== 1 || records[0]?.execution.phase === "awaiting_parent" || records[0]?.usageAttributedAt) {
        return result(formatRecords(records), records.map(compactRecord));
      }
      const all = await orchestrator.all();
      const usage = await treeUsage(records[0], all);
      const attributed = await orchestrator.attributeUsage(records[0].id);
      return { ...result(`${formatRecords([attributed])}\nTree usage: ${formatUsage(usage)}`, [compactRecord(attributed)]), usage };
    },
    renderResult(toolResult) {
      const text = toolResult.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      const details = toolResult.details as { nodes?: unknown } | undefined;
      if (!Array.isArray(details?.nodes)) return new Text(text, 0, 0);
      return {
        render(width: number) {
          return text.split("\n").map((line) => truncateToWidth(line, width, "…"));
        },
        invalidate() {},
      };
    },
  });

  pi.registerTool({
    name: "collect_status",
    label: "Collect Status",
    description: "Request fresh non-terminal reports from every unresolved descendant and aggregate replies for up to 30 seconds.",
    promptSnippet: "Collect a fresh status tree without stopping child work",
    promptGuidelines: [
      "Use collect_status for a fresh recursive progress snapshot; it does not collect terminal results or replace wait_for_children.",
      "After collect_status, return to wait_for_children whenever owned children remain outstanding.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      requireOrchestrator(currentAgent);
      const collected = await orchestrator.collectStatus(ctx.sessionManager.getSessionId(), 30_000);
      const all = await orchestrator.all();
      const selected = delegationTree(all, ctx.sessionManager.getSessionId()).filter((record) =>
        collected.records.some((candidate) => candidate.id === record.id),
      );
      const text = selected.length === 0 ? "No unresolved descendants." : selected.map((record) => {
        const report = record.statusReports?.find((candidate) => candidate.requestId === collected.requestId);
        const state = isResolvedDelegation(record)
          ? `completed while collecting (${record.execution.phase})`
          : report?.summary ?? "timed out";
        return `${delegationTreePrefix(record, all, selected)}${record.agent.name} · ${record.id} · ${state}`;
      }).join("\n");
      return result(`${text}${collected.timedOutIds.length ? `\nTimed out after 30s: ${collected.timedOutIds.join(", ")}` : ""}`, {
        requestId: collected.requestId,
        timedOutIds: collected.timedOutIds,
        records: selected.map(compactRecord),
      });
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
    name: "report_status",
    label: "Report Status",
    description: "Submit a non-terminal status response and continue the current delegated task.",
    promptGuidelines: [
      "Use report_status only for the request ID supplied by a status request, then resume prior work and return to wait_for_children if children remain outstanding.",
    ],
    parameters: Type.Object({
      requestId: Type.String({ minLength: 1 }),
      summary: Type.String({ minLength: 1, maxLength: 4_000 }),
      completed: Type.Optional(Type.Array(Type.String({ maxLength: 2_000 }))),
      current: Type.Optional(Type.String({ maxLength: 2_000 })),
      remaining: Type.Optional(Type.Array(Type.String({ maxLength: 2_000 }))),
      blockers: Type.Optional(Type.Array(Type.String({ maxLength: 2_000 }))),
    }),
    async execute(_id, params) {
      if (mode !== "child" || !childDelegation) throw new Error("report_status requires a delegated child.");
      childDelegation = await orchestrator.reportStatus(childDelegation.id, params);
      return result(`Reported status for ${params.requestId}; continue the prior task.`, { requestId: params.requestId });
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
    description: "Resolve the delegated task, wake its direct parent, and terminate the child run after all child results are collected.",
    promptGuidelines: [
      "Before report_to_parent, repeatedly call wait_for_children, handle questions, and consume every direct-child terminal result; delegation or child_status alone is not completion.",
    ],
    parameters: Type.Object({
      outcome: StringEnum(["completed", "blocked", "failed", "cancelled"] as const),
      summary: Type.String(),
      validation: Type.Optional(Type.Array(Type.String())),
      changedFiles: Type.Optional(Type.Array(Type.String())),
      concerns: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (mode !== "child" || !childDelegation) throw new Error("report_to_parent requires a delegated child.");
      const outstanding = (await orchestrator.children(ctx.sessionManager.getSessionId()))
        .filter((record) => !isResolvedDelegation(record) || !record.parentCollectedAt);
      if (outstanding.length > 0) throw new Error(`Resolve and collect ${outstanding.length} child delegation(s) before reporting.`);
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
  if (!agent?.root || !agent.tools.includes("workspace_subagent")) {
    throw new Error("Only the root thinker can manage delegated workspaces.");
  }
  return agent;
}

function requireDelegatedWorkspace(record: DelegationRecord): void {
  if (!record.workspace || (record.agent.name !== "planner" && record.agent.name !== "worker")) {
    throw new Error(`Delegation ${record.id} is not an isolated planner or worker workspace.`);
  }
}

function workspaceName(requested: string | undefined, objective: string, agent: "planner" | "worker"): string {
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
  return `${agent}-${slug}-${randomUUID().slice(0, 8)}`;
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

function compactRecord(record: DelegationRecord) {
  return {
    id: record.id,
    agent: record.agent.name,
    objective: record.task.objective,
    phase: record.execution.phase,
    ...(record.parentDelegationId ? { parentDelegationId: record.parentDelegationId } : {}),
    ...(childReport(record) ? { report: childReport(record) } : {}),
  };
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
