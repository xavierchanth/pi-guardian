import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
import { childContextId, fileSetClaimId } from "../concurrency/ids.ts";
import { ChildContextCoordinator } from "../concurrency/coordinator.ts";
import { HostConcurrencyRepository, type HostServiceClientPort } from "../concurrency/host-repository.ts";
import { HostConcurrencyState } from "../concurrency/host-state.ts";
import { HostLegacyContextMigrator } from "../concurrency/legacy-import.ts";
import { HostReviewStore } from "../concurrency/reviews.ts";
import { HostTaskStore, type TaskOwnerRole } from "../concurrency/tasks.ts";
import { FileChildContextStore, HostChildContextStore, type ChildContextStore, type PersistedChildContextV4 } from "../concurrency/persistence.ts";
import { ChildEventProtocol } from "../concurrency/protocol.ts";
import { ChildEventWaitRegistry } from "../concurrency/waits.ts";
import { ChildJournalRetention, ChildUsageLedger } from "../concurrency/usage.ts";
import { ChildContextReconciler } from "../concurrency/reconcile.ts";
import { classifySharedShellCommand, registerSharedMutationGuard } from "../concurrency/source-guard.ts";
import { changeDescription, changeId, checkpointableFileSetClaim, conflictResolutionLease, isolatedWorkspaceWriteLease, workspaceId as jjWorkspaceId, workspaceName as jjWorkspaceName, workspaceRebaseLease, workspaceWriteLeaseId } from "../jj/domain.ts";
import { IsolatedJjRuntime } from "../jj/isolated-runtime.ts";
import { FileRepositoryEnrollmentStore, HostRepositoryEnrollmentStore, RepositoryEnrollmentService } from "../jj/repository-enrollment.ts";
import { SharedJjRuntime } from "../jj/runtime.ts";
import { HostSharedSourceStore } from "../jj/persistence.ts";
import { HostIsolatedWorkspaceStore } from "../jj/workspace-persistence.ts";
import type { WorkspaceAttachment, WorkspacePort } from "../workspaces/domain.ts";
import { JjWorkspacePort } from "../workspaces/jj.ts";
import {
  discoverAgentDefinitions,
  validateAgentTools,
  type AgentCatalog,
  type AgentDefinition,
} from "./agents.ts";
import {
  PARENT_TOOL_NAMES,
  activeToolsForMode,
  childProtocolToolsForUncertainty,
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
  MemoryDelegationStore,
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
  formatUsage,
  treeUsage,
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
  contextStore?: ChildContextStore;
  protocol?: ChildEventProtocol;
  waits?: ChildEventWaitRegistry;
  usageLedger?: ChildUsageLedger;
  retention?: ChildJournalRetention;
  reconciler?: ChildContextReconciler;
  sharedJj?: SharedJjRuntime;
  isolatedJj?: IsolatedJjRuntime;
  agentDir?: string;
  hostServices?: HostServiceClientPort;
  enrollment?: RepositoryEnrollmentService;
  rootSessionId?: string;
}

export function registerSubagents(
  pi: ExtensionAPI,
  dependencies: SubagentDependencies = {},
): void {
  const agentDir = dependencies.agentDir ?? getAgentDir();
  const storeRoot = process.env[STORE_ENV]
    || join(agentDir, "pi-tai", "subagents", "delegations");
  const store = dependencies.store ?? (dependencies.config ? new MemoryDelegationStore() : new FileDelegationStore(storeRoot));
  const orchestrator = dependencies.orchestrator ?? new SubagentOrchestrator({
    store,
    launcher: dependencies.config ? {
      launch: async () => { throw new Error("Production child launch requires a private Pi SDK context."); },
      message: async () => { throw new Error("Production child messaging requires a live private Pi SDK context."); },
      cleanup: async () => undefined,
    } : new PiChildProcessLauncher(store),
  });
  const stateRoot = dirname(storeRoot);
  const hostConcurrency = dependencies.hostServices ? new HostConcurrencyRepository(dependencies.hostServices) : undefined;
  const hostState = hostConcurrency && dependencies.rootSessionId ? new HostConcurrencyState({ repository: hostConcurrency, rootSessionId: dependencies.rootSessionId, runtimeGeneration: 1 }) : undefined;
  const sharedJj = dependencies.sharedJj ?? new SharedJjRuntime({ stateRoot, ...(hostState ? { store: new HostSharedSourceStore(hostState) } : {}) });
  const isolatedJj = dependencies.isolatedJj ?? new IsolatedJjRuntime({ stateRoot, shared: sharedJj, ...(hostState ? { workspaces: new HostIsolatedWorkspaceStore(hostState), taskStore: new HostTaskStore(hostState), reviewStore: new HostReviewStore(hostState) } : {}) });
  const isolatedReady = isolatedJj.initialize();
  const contextStore = dependencies.contextStore ?? (hostConcurrency && dependencies.rootSessionId
    ? new HostChildContextStore({ repository: hostConcurrency, rootSessionId: dependencies.rootSessionId, runtimeGeneration: 1 })
    : new FileChildContextStore(join(stateRoot, "context-records")));
  const usageLedger = dependencies.usageLedger ?? new ChildUsageLedger(contextStore);
  const legacyMigrator = hostState && dependencies.config ? new HostLegacyContextMigrator(contextStore, hostState) : undefined;
  let legacyMigration: Promise<unknown> | undefined;
  const enrollment = dependencies.enrollment ?? new RepositoryEnrollmentService({ store: dependencies.hostServices ? new HostRepositoryEnrollmentStore(dependencies.hostServices) : new FileRepositoryEnrollmentStore(join(stateRoot, "repository-enrollments")) });
  const retention = dependencies.retention ?? new ChildJournalRetention(contextStore, stateRoot);
  const coordinator = dependencies.coordinator ?? (dependencies.config
    ? new ChildContextCoordinator({
        store: contextStore,
        sessionFactory: new PrivateChildSessionFactory({ config: dependencies.config }),
        usageLedger,
        stateRoot,
        agentDir,
        onCancelled: async (context) => {
          if (!await store.get(context.contextId) || context.execution.phase !== "cancelled") return;
          const finishedAt = context.execution.finishedAt;
          await store.update(context.contextId, (current) => ({
            ...current,
            execution: {
              phase: "cancelled",
              report: {
                outcome: "cancelled",
                summary: "Cancelled by parent.",
                reportedAt: finishedAt,
              },
            },
          }));
        },
      })
    : undefined);
  const waits = dependencies.waits ?? new ChildEventWaitRegistry();
  const publishHostProjection = async (rootSessionId: string, eventType: string, payload: unknown): Promise<void> => {
    if (!hostConcurrency) return;
    const all = (await contextStore.list()).filter((record) => record.rootSessionId === rootSessionId);
    const ordered = [...all].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const selected = ordered.slice(0, 256);
    const workspaceRecords = (await isolatedJj.workspaces.list()).filter((record) => (record.phase === "allocating" || record.phase === "incident" ? record.workspaceId : record.identity.workspaceId) && (record.phase === "allocating" ? record.allocation.rootSessionId : record.phase === "incident" ? record.identity?.rootSessionId === rootSessionId : record.identity.rootSessionId === rootSessionId)).slice(0, 256);
    const usage = await usageLedger.totals(rootSessionId);
    const sources = await sharedJj.store.list();
    const current = await hostConcurrency.load();
    const expectedRevision = current?.revision ?? 0;
    const projection = {
      version: 1 as const, rootSessionId, revision: expectedRevision + 1, generatedAt: new Date().toISOString(),
      children: selected.map((record) => ({ contextId: record.contextId, ...(record.parentContextId ? { parentContextId: record.parentContextId } : {}), ...(record.taskId ? { taskId: record.taskId } : {}), role: record.agent.name, objective: record.task.objective, phase: record.execution.phase, ...(record.execution.cycleId ? { executionCycleId: record.execution.cycleId } : {}), ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}), ...("questionEventId" in record.execution ? { questionId: record.execution.questionEventId } : {}), ...("terminalEventId" in record.execution ? { terminalEventId: record.execution.terminalEventId } : {}), updatedAt: record.updatedAt })),
      inactiveChildCount: Math.max(0, all.length - selected.length),
      tasks: ((current?.state as any)?.tasks ?? []).slice(0, 256).map((task: any) => ({ taskId: task.taskId, ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}), ownerRole: task.ownerRole, objective: task.assignment?.objective ?? task.goal?.objective ?? "Task", executionPhase: task.execution?.phase ?? "unknown", childTaskCount: task.childTaskIds?.length ?? 0, planRevisionCount: task.planRevisions?.length ?? 0, directionCount: task.directions?.length ?? 0, updatedAt: task.updatedAt })),
      inactiveTaskCount: Math.max(0, (((current?.state as any)?.tasks ?? []).length - 256)),
      workspaces: workspaceRecords.map((record) => ({ workspaceId: record.phase === "allocating" || record.phase === "incident" ? record.workspaceId : record.identity.workspaceId, ...("taskId" in record ? { taskId: record.taskId } : {}), phase: record.phase, receiptDigests: [], ...(record.phase === "incident" ? { incidentSummary: record.reason } : {}), updatedAt: record.updatedAt })),
      activeClaimCount: sources.flatMap((source) => source.claims).filter((claim) => claim.rootSessionId === rootSessionId && (claim.phase === "active" || claim.phase === "checkpointing")).length,
      unansweredQuestionCount: all.flatMap((record) => record.events).filter((event) => event.kind === "question" && !(event.payload as any)?.answeredAt).length,
      usage: usage.total, telemetryGapCount: all.reduce((total, context) => total + context.telemetryGaps.length, 0), truncated: all.length > selected.length || workspaceRecords.length >= 256,
    };
    await hostConcurrency.transact({ version: 1, transactionId: `concurrency-transaction-${randomUUID()}`, rootSessionId, runtimeGeneration: 1, expectedRevision, events: [{ eventId: `concurrency-event-${randomUUID()}`, type: eventType, payload }], state: current?.state ?? { version: 1, contexts: all }, projection });
  };
  const protocol = dependencies.protocol ?? (coordinator
    ? new ChildEventProtocol({ store: contextStore, coordinator, rootBridge: pi, onDelivered: (event) => { waits.notify(event); void contextStore.get(event.contextId).then((context) => context && publishHostProjection(context.rootSessionId, `child.${event.kind}`, event)).catch(() => undefined); } })
    : undefined);
  const reconciler = dependencies.reconciler ?? (coordinator
    ? new ChildContextReconciler({ store: contextStore, coordinator, waits })
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

  const authoritativeRootSessionId = (ctx: ExtensionContext) => dependencies.rootSessionId ?? childDelegation?.parentSessionId ?? ctx.sessionManager.getSessionId();
  const taskForContext = async (ctx: ExtensionContext) => {
    if (childDelegation) return (await contextStore.get(childDelegation.id))?.taskId ? isolatedJj.tasks.get((await contextStore.get(childDelegation.id))!.taskId!) : undefined;
    return isolatedJj.tasks.findRoot(authoritativeRootSessionId(ctx));
  };
  const latestUserEvidence = (ctx: ExtensionContext) => {
    const entry = [...ctx.sessionManager.getBranch()].reverse().find((item: any) => item.type === "message" && item.message?.role === "user") as any;
    if (!entry) throw new Error("No user message is available as task authority evidence.");
    const content = typeof entry.message.content === "string" ? entry.message.content : Array.isArray(entry.message.content) ? entry.message.content.filter((item: any) => item?.type === "text").map((item: any) => item.text).join("\n") : "";
    if (!content.trim()) throw new Error("Latest user message has no textual task evidence.");
    return { messageId: String(entry.id), content, contentHash: createHash("sha256").update(content).digest("hex"), observedAt: new Date().toISOString() };
  };

  const taskStateRoots = [join(stateRoot, "tasks"), join(stateRoot, "task-artifacts")];
  const canonicalPath = async (path: string) => realpath(path).catch(() => resolve(path));
  const containsPath = (root: string, target: string) => { const remainder = relative(root, target); return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder)); };
  const overlapsTaskState = async (path: string) => { const target = await canonicalPath(path); for (const root of taskStateRoots) { const canonicalRoot = await canonicalPath(root); if (containsPath(canonicalRoot, target) || containsPath(target, canonicalRoot)) return true; } return false; };
  const isolatedAuthorizedMutations = new Map<string, { workspaceId: string; ownerContextId: string; path: string }>();

  pi.on("tool_call", async (event, ctx) => {
    if (mode !== "child" || !childDelegation) return undefined;
    const context = await contextStore.get(childDelegation.id);
    if (["read", "grep", "find", "ls"].includes(event.toolName)) {
      const input = event.input as Record<string, unknown>;
      const requested = typeof input.path === "string" ? input.path : ".";
      const target = resolve(ctx.cwd, requested);
      if (await overlapsTaskState(target)) {
        const allowedReviewerPaths = context?.agent.name === "reviewer"
          ? (context.task.resources ?? []).filter((resource) => resource.type === "file").map((resource) => resolve(ctx.cwd, resource.value))
          : [];
        const canonicalTarget = await canonicalPath(target);
        const allowed = await Promise.all(allowedReviewerPaths.map(canonicalPath));
        if (!allowed.includes(canonicalTarget)) return { block: true, reason: "Task persistence and superseded plan artifacts are unavailable to this role; use the role-scoped task projection." };
      }
    }
    if (event.toolName === "bash") {
      const command = typeof (event.input as Record<string, unknown>).command === "string" ? String((event.input as Record<string, unknown>).command) : "";
      if (taskStateRoots.some((root) => command.includes(root)) || /(?:^|[\s'\"])(?:~|\.{0,2}|\/)[^\s'\"]*\/(?:tasks|task-artifacts)(?:\/|[\s'\"]|$)/.test(command)) return { block: true, reason: "Shell access to task persistence and plan-history artifacts is unavailable to delegated roles." };
    }
    if (!["write", "edit", "bash"].includes(event.toolName)) return undefined;
    await isolatedReady;
    if (!context?.workspaceId) return undefined;
    const tracked = await isolatedJj.workspaces.get(context.workspaceId);
    if (context.agent.name === "reviewer") {
      if (event.toolName === "write" || event.toolName === "edit") return { block: true, reason: "Reviewers are read-only." };
      const reviewerInput = event.input as Record<string, unknown>;
      const decision = classifySharedShellCommand(typeof reviewerInput.command === "string" ? reviewerInput.command : "");
      return decision.kind === "allowed" ? undefined : { block: true, reason: `Reviewer shell is read-only: ${decision.reason}` };
    }
    if (!tracked || tracked.phase !== "active") return { block: true, reason: "Isolated workspace mutation requires active workspace custody." };
    const legacyWriter = tracked.writer.phase === "leased" && tracked.writer.ownerContextId === context.contextId;
    const workspaceClaim = await isolatedJj.workspaceFileSets.activeForOwner(jjWorkspaceId(context.workspaceId), context.contextId);
    if (event.toolName === "write" || event.toolName === "edit") {
      const path = typeof (event.input as Record<string, unknown>).path === "string" ? String((event.input as Record<string, unknown>).path) : undefined;
      if (!path) return { block: true, reason: "Workspace mutation requires a concrete file path." };
      if (workspaceClaim?.record.phase === "active") {
        const authorizedPath = await isolatedJj.workspaceFileSets.authorizePath(jjWorkspaceId(context.workspaceId), context.contextId, path);
        isolatedAuthorizedMutations.set(event.toolCallId, { workspaceId: context.workspaceId, ownerContextId: context.contextId, path: authorizedPath });
      } else if (!legacyWriter) return { block: true, reason: "Isolated workspace mutation requires an active covering workspace file-set claim." };
    }
    if (event.toolName === "bash" && !workspaceClaim && !legacyWriter) return { block: true, reason: "Isolated workspace validation requires an active workspace file-set claim." };
    if (event.toolName === "bash") {
      const decision = classifySharedShellCommand(typeof event.input.command === "string" ? event.input.command : "");
      if (decision.kind !== "allowed") return { block: true, reason: decision.reason.replaceAll("Shared-worker", "Isolated-worker").replaceAll("shared workers", "isolated workers") };
    }
    return undefined;
  });

  pi.on("tool_result", async (event) => {
    const mutation = isolatedAuthorizedMutations.get(event.toolCallId);
    if (!mutation) return undefined;
    isolatedAuthorizedMutations.delete(event.toolCallId);
    if (!event.isError) await isolatedJj.workspaceFileSets.recordOwnedMutation(jjWorkspaceId(mutation.workspaceId), mutation.ownerContextId, mutation.path);
    return undefined;
  });

  registerSharedMutationGuard(pi, {
    openSource: (cwd) => sharedJj.openSource(cwd),
    fileSets: sharedJj.fileSets,
    state: () => {
      const sharedWorker = mode === "child" && currentAgent?.name === "worker" && childDelegation !== undefined && childDelegation.workspace === undefined;
      return {
        enabled: mode === "root" || sharedWorker,
        ...(sharedWorker && childDelegation ? { ownerContextId: childDelegation.id, constrainShell: true } : {}),
      };
    },
  });

  const childRuntimeExtensions = (contextId: string) => [{
    name: `pi-tai-child-runtime-${contextId}`,
    factory: (childPi: ExtensionAPI) => registerSubagents(childPi, {
      store,
      orchestrator,
      coordinator,
      contextStore,
      ...(protocol ? { protocol } : {}),
      waits,
      usageLedger,
      retention,
      ...(reconciler ? { reconciler } : {}),
      sharedJj,
      isolatedJj,
      ...(dependencies.config ? { config: dependencies.config } : {}),
      loadInstructions,
      discoverAgents: discover,
      childDelegationId: contextId,
      workspace,
      agentDir,
      ...(dependencies.hostServices ? { hostServices: dependencies.hostServices } : {}),
      enrollment,
      ...(dependencies.rootSessionId ? { rootSessionId: dependencies.rootSessionId } : {}),
    }),
  }];

  const spawnManagedChild = async (input: {
    task: Parameters<SubagentOrchestrator["spawnChild"]>[0]["task"];
    agent: AgentDefinition;
    caller: AgentDefinition;
    parentCwd: string;
    parentSessionId: string;
    parentDelegationId?: string;
    contextId?: string;
    taskId?: string;
    workspaceId?: string;
    workspace?: WorkspaceAttachment;
    modelRegistry: ExtensionContext["modelRegistry"];
  }): Promise<DelegationRecord> => {
    if (!coordinator) return orchestrator.spawnChild(input);
    const task = normalizeTaskPacket(input.task, input.agent.uncertaintyHandling);
    const agent = snapshotAgentDefinition(input.agent);
    const caller = snapshotAgentDefinition(input.caller);
    const context = await coordinator.spawn({
      rootSessionId: dependencies.rootSessionId ?? childDelegation?.parentSessionId ?? input.parentSessionId,
      ...(input.parentDelegationId ? { parentContextId: input.parentDelegationId } : {}),
      cwd: input.parentCwd,
      task,
      agent,
      caller,
      modelRegistry: input.modelRegistry,
      ...(input.contextId ? { contextId: input.contextId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(!input.workspaceId && input.workspace ? { workspace: input.workspace } : {}),
      extensions: childRuntimeExtensions,
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
    await publishHostProjection(context.rootSessionId, "child.created", { contextId: context.contextId, role: context.agent.name, taskId: context.taskId });
    return orchestrator.child(context.contextId);
  };

  const emitChildEvent = async (input: Parameters<ChildEventProtocol["emit"]>[2]) => {
    if (!protocol || !childDelegation) return undefined;
    const context = await contextStore.get(childDelegation.id);
    if (!context?.execution.cycleId) return undefined;
    return protocol.emit(childDelegation.id, context.execution.cycleId, input);
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
    const context = await contextStore.get(selected.id);
    const usage = context ? await usageLedger.totals(context.rootSessionId, context.contextId) : undefined;
    const latestEvent = context ? [...context.events].reverse().find((event) => event.kind === "question" || event.kind === "terminal" || event.kind === "incident" || event.kind === "status") : undefined;
    const detail = context ? [
      `SUBAGENT\n${context.contextId}`,
      `AGENT\n${context.agent.name}`,
      `STATUS\n${context.execution.phase}`,
      `OBJECTIVE\n${context.task.objective}`,
      `TASK\n${context.taskId ?? "unbound"}`,
      `WORKSPACE\n${context.workspaceId ?? "none"}`,
      latestEvent ? `LATEST SEMANTIC EVENT\n${latestEvent.kind} · ${latestEvent.eventId}` : "LATEST SEMANTIC EVENT\nnone",
      `USAGE\n${usage!.total.input + usage!.total.output + usage!.total.cacheRead + usage!.total.cacheWrite} tokens · $${usage!.total.cost.toFixed(4)}`,
    ].join("\n\n") : [
      `SUBAGENT\n${selected.id}`, `AGENT\n${selected.agent.name}`, `STATUS\n${selected.execution.phase}`, `OBJECTIVE\n${selected.task.objective}`,
      "LATEST SEMANTIC EVENT\nlegacy projection unavailable", "USAGE\nunavailable",
    ].join("\n\n");
    if (ctx.mode !== "tui") {
      ctx.ui.notify(detail, "info");
      return;
    }
    await showInlinePane(ctx, [{ label: `Inspect · ${selected.agent.name} · ${selected.id}`, content: detail }]);
  };

  const availableToolNames = () => new Set(pi.getAllTools().map((tool) => tool.name));

  const configuredTools = (agent: AgentDefinition, child: boolean): string[] => [
    ...agent.tools,
    ...(child ? childProtocolToolsForUncertainty(agent.uncertaintyHandling) : []),
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

  pi.on("input", (_event, ctx) => {
    const callerId = childDelegation?.id ?? ctx.sessionManager.getSessionId();
    waits.interrupt(callerId);
  });

  pi.on("session_start", async (event, ctx) => {
    if (dependencies.config) {
      if (legacyMigrator && !legacyMigration) legacyMigration = new FileDelegationStore(storeRoot).list().then((records) => legacyMigrator.run(authoritativeRootSessionId(ctx), records));
      await legacyMigration;
      const contexts = (await contextStore.list()).filter((record) => record.rootSessionId === authoritativeRootSessionId(ctx));
      const byId = new Map(contexts.map((record) => [record.contextId, record]));
      for (const context of contexts) {
        if (await store.get(context.contextId)) continue;
        const parent = context.parentContextId ? byId.get(context.parentContextId) : undefined;
        const parentSessionId = parent && (parent.execution.phase === "running" || parent.execution.phase === "awaiting_parent") ? parent.execution.sessionId : ctx.sessionManager.getSessionId();
        await store.create(projectContextDelegation(context, parentSessionId));
      }
    }
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
      } else if (reconciler) {
        await reconciler.reconcile({
          rootSessionId: authoritativeRootSessionId(ctx),
          modelRegistry: ctx.modelRegistry,
          extensions: childRuntimeExtensions,
        });
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
        if (typeof pi.sendMessage === "function") {
          pi.sendMessage({
            customType: "pi-tai-child-event-v1",
            content: `You still own ${outstanding.length} unresolved or unacknowledged direct child result(s). Continue the orchestration loop now.`,
            display: false,
            details: { kind: "outstanding_children", count: outstanding.length },
          }, { deliverAs: "steer", triggerTurn: true });
        }
        return;
      }
    }
    if (mode !== "child" || !childDelegation) return;
    childDelegation = await orchestrator.settle(
      childDelegation.id,
      (settledAssistantText ?? "Child agent settled without an explicit report.").slice(0, 16_000),
    );
    if (isResolvedDelegation(childDelegation)) {
      const report = childReport(childDelegation);
      const context = await contextStore.get(childDelegation.id);
      if (report && context && !context.events.some((event) => event.kind === "terminal")) {
        await emitChildEvent({
          kind: "terminal",
          outcome: report.outcome,
          summary: report.summary,
          ...(report.validation ? { validation: report.validation } : {}),
          ...(report.changedFiles ? { changedFiles: report.changedFiles } : {}),
          ...(report.concerns ? { concerns: report.concerns } : {}),
        });
      }
      ctx.shutdown();
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    waits.cancel(childDelegation?.id ?? ctx.sessionManager.getSessionId());
    stopChildWidget(ctx);
    if (mode === "root" && coordinator) await coordinator.disposeRoot(ctx.sessionManager.getSessionId());
    if (event.reason === "quit" && mode === "child" && childDelegation?.id) {
      if (coordinator?.getRuntime(childDelegation.id)) coordinator.releaseRuntime(childDelegation.id);
      else await orchestrator.cleanupChildControl(childDelegation.id);
    }
  });

  pi.registerCommand("init-pi-tai", {
    description: "Initialize and permanently approve Pi-Tai managed JJ workspaces for this repository",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const planned = await enrollment.plan(ctx.cwd);
      if (planned.enrollment?.phase === "ready") {
        try {
          const receipt = await enrollment.verify(ctx.cwd);
          ctx.ui.notify(`Pi-Tai is initialized for this repository. Managed workspaces: ${receipt.managedWorkspaceRoot}`, "info");
          return;
        } catch { /* display and authorize the exact repair plan below */ }
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("Pi-Tai repository initialization requires one interactive approval.", "error");
        return;
      }
      const plan = planned.plan;
      const initialization = plan.initializationMode === "existing_jj"
        ? "Use the existing JJ repository"
        : plan.initializationMode === "colocate_git"
          ? "Initialize JJ colocated with the existing Git repository"
          : "Initialize a new colocated JJ/Git repository";
      const approved = await ctx.ui.confirm(
        "Initialize Pi-Tai for this repository?",
        [
          initialization,
          `Repository: ${plan.repositoryPath}`,
          `Managed workspaces: ${plan.managedWorkspaceRoot}`,
          `Add repo-local revset alias: ${plan.privateRevsetAlias} = ${plan.privateRevsetExpression}`,
          `Extend git.private-commits to: ${plan.nextPrivateCommits}`,
          "This one approval authorizes future Pi-Tai session and child workspaces only below the managed root. It does not authorize publication, destructive recovery, or changes to your default workspace.",
        ].join("\n\n"),
      );
      if (!approved) {
        ctx.ui.notify("Pi-Tai repository initialization was cancelled; no planned mutation was executed.", "info");
        return;
      }
      const receipt = await enrollment.enroll(plan, {
        authorizationId: `repository-consent-${randomUUID()}`,
        planDigest: plan.planDigest,
        authorizedAt: new Date().toISOString(),
      });
      ctx.ui.notify(`Pi-Tai initialized. Future managed workspaces are approved below ${receipt.managedWorkspaceRoot}.`, "info");
    },
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
    name: "task_create",
    label: "Create Task",
    description: "Persist one immutable thinker-owned task goal from the latest user request.",
    parameters: Type.Object({ objective: Type.String(), acceptanceCriteria: Type.Optional(Type.Array(Type.String())), constraints: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (mode !== "root" || currentAgent?.name !== "thinker") throw new Error("Only the root thinker may create a root task.");
      const existing = await isolatedJj.tasks.findRoot(authoritativeRootSessionId(ctx)); if (existing) throw new Error(`Root task ${existing.taskId} already exists.`);
      const task = await isolatedJj.tasks.createRoot({ rootSessionId: authoritativeRootSessionId(ctx), thinkerContextId: `thinker-${authoritativeRootSessionId(ctx)}`, objective: params.objective, acceptanceCriteria: params.acceptanceCriteria, constraints: params.constraints, userRequest: latestUserEvidence(ctx) });
      return result(`Created durable task ${task.taskId}.`, task);
    },
  });

  pi.registerTool({
    name: "task_assign",
    label: "Assign Task",
    description: "Create an immutable child task assignment before launching its execution context.",
    parameters: Type.Object({ ownerRole: StringEnum(["planner", "worker", "reviewer", "scout", "researcher"] as const), objective: Type.String(), acceptanceCriteria: Type.Optional(Type.Array(Type.String())), constraints: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const parent = await taskForContext(ctx); if (!parent) throw new Error("Create or bind a durable parent task first.");
      const creator = childDelegation?.id ?? `thinker-${ctx.sessionManager.getSessionId()}`; const task = await isolatedJj.tasks.assign(parent.taskId, { ownerRole: params.ownerRole, creatorContextId: creator, objective: params.objective, acceptanceCriteria: params.acceptanceCriteria, constraints: params.constraints });
      return result(`Created ${params.ownerRole} task ${task.taskId}.`, task);
    },
  });

  pi.registerTool({
    name: "task_plan",
    label: "Revise Task Plan",
    description: "Replace the caller-owned task's current effective plan while retaining immutable revision history.",
    parameters: Type.Object({
      markdown: Type.String({ description: "Complete replacement text for the current effective plan" }),
      rationale: Type.String(),
      directionIds: Type.Optional(Type.Array(Type.String(), { maxItems: 64, description: "Sourced user directions that caused this replacement" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const task = await taskForContext(ctx); if (!task) throw new Error("No durable task is bound to this context."); const role = currentAgent?.name === "planner" ? "planner" : currentAgent?.name === "thinker" ? "thinker" : undefined; if (!role) throw new Error("Only thinkers and planners may revise task plans."); const contextId = childDelegation?.id ?? `thinker-${ctx.sessionManager.getSessionId()}`;
      await isolatedJj.tasks.appendPlan(task.taskId, { authorContextId: contextId, authorRole: role, markdown: params.markdown, rationale: params.rationale, ...(params.directionIds ? { directionIds: params.directionIds } : {}) });
      const status = await isolatedJj.tasks.status(task.taskId, role);
      return result(`Replaced the current effective plan for ${task.taskId}.`, status);
    },
  });

  pi.registerTool({
    name: "task_record_user_direction",
    label: "Record User Direction",
    description: "Append the latest user-authored clarification to the root task with message provenance.",
    parameters: Type.Object({ summary: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (mode !== "root" || currentAgent?.name !== "thinker") throw new Error("Only the root thinker may record user direction."); const task = await isolatedJj.tasks.findRoot(authoritativeRootSessionId(ctx)); if (!task) throw new Error("No root task exists."); const updated = await isolatedJj.tasks.recordDirection(task.taskId, { thinkerContextId: `thinker-${ctx.sessionManager.getSessionId()}`, evidence: latestUserEvidence(ctx), summary: params.summary }); return result(`Recorded user direction on ${task.taskId}.`, updated);
    },
  });

  pi.registerTool({
    name: "task_status",
    label: "Task Status",
    description: "Inspect the caller's role-scoped durable task projection; execution roles receive only current effective plans.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const task = await taskForContext(ctx); if (!task) throw new Error("No durable task is bound to this context.");
      const role = currentAgent?.name;
      if (!role || !["thinker", "planner", "worker", "reviewer"].includes(role)) throw new Error("This role has no task-status projection.");
      const status = await isolatedJj.tasks.status(task.taskId, role as TaskOwnerRole);
      return result(`Task projection contains ${status.tasks.length} task(s).`, status);
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
      "Before completing delegated work, repeatedly use await_child_event, handle each pushed question or terminal event, and acknowledge terminal events until every direct child is resolved.",
    ],
    parameters: Type.Object({
      agent: Type.String({ description: "Allowed child agent name" }),
      taskId: Type.Optional(Type.String({ description: "Durable task assignment to bind" })),
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
      const parentContext = childDelegation ? await contextStore.get(childDelegation.id) : undefined;
      const writableWorkspaceChild = target.name === "worker" && parentContext?.workspaceId;
      const contextId = writableWorkspaceChild ? randomUUID() : undefined;
      let transferredLease: ReturnType<typeof isolatedWorkspaceWriteLease> | undefined;
      if (writableWorkspaceChild && contextId) {
        const tracked = await isolatedJj.workspaces.get(writableWorkspaceChild);
        if (!tracked || tracked.phase !== "active" || tracked.writer.phase !== "leased" || tracked.writer.ownerContextId !== parentContext?.contextId) throw new Error("Parent does not hold a transferable workspace writer lease.");
        transferredLease = await isolatedJj.operations.transferWriter(isolatedWorkspaceWriteLease(jjWorkspaceId(writableWorkspaceChild), workspaceWriteLeaseId(tracked.writer.leaseId)), contextId);
      }
      let record: DelegationRecord;
      try {
        record = await spawnManagedChild({
          task: params.task, agent: target, caller,
          parentCwd: ctx.cwd, parentSessionId: ctx.sessionManager.getSessionId(),
          ...(childDelegation ? { parentDelegationId: childDelegation.id } : {}),
          ...(contextId ? { contextId } : {}),
          ...(params.taskId ? { taskId: params.taskId } : {}),
          ...(writableWorkspaceChild ? { workspaceId: writableWorkspaceChild } : {}),
          modelRegistry: ctx.modelRegistry,
        });
      } catch (error) {
        if (transferredLease && parentContext) await isolatedJj.operations.transferWriter(transferredLease, parentContext.contextId);
        throw error;
      }
      if (params.taskId) await isolatedJj.tasks.bind(params.taskId, record.id);
      await refreshChildWidget(ctx);
      return result(`Spawned ${record.agent.name} child ${record.id} in ${record.cwd}.`, record);
    },
  });

  pi.registerTool({
    name: "jj_concurrency_status",
    label: "JJ Concurrency Status",
    description: "Inspect bounded shared-source WIP, target, claim, and recovery state without mutating JJ.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (!currentAgent) throw new Error("JJ concurrency status requires an active Pi-Tai role.");
      const source = await sharedJj.openSource(ctx.cwd);
      const status = await sharedJj.operations.inspectStatus(source);
      const durable = await sharedJj.store.get(source.sourceId);
      return result("Inspected shared JJ concurrency state.", {
        ...status,
        sourceId: source.sourceId,
        targets: durable?.targets.slice(-64) ?? [],
        claims: durable?.claims.slice(-64) ?? [],
        operations: durable?.operations.slice(-64).map(({ operationId, kind, phase, startedAt }) => ({ operationId, kind, phase, startedAt })) ?? [],
      });
    },
  });

  pi.registerTool({
    name: "ensure_wip_change",
    label: "Ensure WIP Change",
    description: "Verify or canonically describe the root thinker's empty shared-source orchestration WIP without relabeling unknown work.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      requireWorkspaceThinker(currentAgent);
      const source = await sharedJj.openSource(ctx.cwd);
      const outcome = await sharedJj.operations.ensureWip(source);
      return result(outcome.kind === "completed" ? `Shared WIP ${outcome.receipt.wipChangeId} is ready.` : `Shared WIP preparation stopped: ${outcome.blocker.kind}.`, outcome);
    },
  });

  pi.registerTool({
    name: "insert_change",
    label: "Insert Shared Change",
    description: "Insert one named empty shared target before the same WIP and bind it to a direct shared worker context.",
    promptGuidelines: [
      "Spawn the shared worker first with instructions not to edit until assigned, then insert_change for that child context and message it to acquire its complete file set.",
      "The description must be a meaningful Conventional Commit description for the bounded shared work.",
    ],
    parameters: Type.Object({
      ownerContextId: Type.String({ minLength: 1, maxLength: 128, description: "Direct shared worker context returned by subagent" }),
      description: Type.String({ minLength: 1, maxLength: 4_096 }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireWorkspaceThinker(currentAgent);
      const owner = await requireDirectChild(orchestrator, params.ownerContextId, ctx.sessionManager.getSessionId());
      if (owner.agent.name !== "worker" || owner.workspace) throw new Error("Inserted shared changes can be assigned only to a direct non-workspace worker.");
      if (isResolvedDelegation(owner)) throw new Error(`Worker ${owner.id} is already terminal and cannot receive a shared target.`);
      const source = await sharedJj.openSource(ctx.cwd);
      const outcome = await sharedJj.operations.insertChange(source, {
        description: changeDescription(params.description),
        owner: childContextId(owner.id),
      });
      return result(outcome.kind === "completed" ? `Inserted shared target ${outcome.receipt.insertedChangeId} for ${owner.id}.` : `Shared target insertion stopped: ${outcome.blocker.kind}.`, outcome);
    },
  });

  pi.registerTool({
    name: "acquire_file_set",
    label: "Acquire File Set",
    description: "Acquire the complete canonical shared-source path set assigned to this worker; overlapping requests wait FIFO.",
    parameters: Type.Object({
      paths: Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), { minItems: 1, maxItems: 128 }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const owner = requireSharedWorker(currentAgent, childDelegation);
      const source = await sharedJj.openSource(ctx.cwd);
      const claim = await sharedJj.fileSets.acquire(source, {
        rootSessionId: owner.parentSessionId,
        ownerContextId: owner.id,
        paths: params.paths,
        signal,
      });
      const active = await sharedJj.fileSets.requireActive(claim);
      return result(`Acquired file-set claim ${claim.claimId}. Re-read every target before editing.`, {
        claimId: claim.claimId,
        paths: active.record.paths,
        targetChangeId: active.record.targetChangeId,
        acquiredAt: active.record.acquiredAt,
      });
    },
  });

  pi.registerTool({
    name: "release_file_set",
    label: "Release File Set",
    description: "Release this shared worker's unused active file set. Mutated sets must use checkpoint_change.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const owner = requireSharedWorker(currentAgent, childDelegation);
      const source = await sharedJj.openSource(ctx.cwd);
      const active = await sharedJj.fileSets.activeForOwner(source, owner.id);
      if (!active) throw new Error("This worker has no active shared file-set claim.");
      await sharedJj.fileSets.releaseUnused(active.handle);
      return result(`Released unused file-set claim ${active.handle.claimId}.`, { claimId: active.handle.claimId });
    },
  });

  pi.registerTool({
    name: "checkpoint_change",
    label: "Checkpoint Shared Change",
    description: "Move only this worker's locked shared-source paths into its assigned inserted Change ID and release after receipt verification.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const owner = requireSharedWorker(currentAgent, childDelegation);
      const source = await sharedJj.openSource(ctx.cwd);
      const active = await sharedJj.fileSets.activeForOwner(source, owner.id);
      if (!active) throw new Error("This worker has no active shared file-set claim.");
      const outcome = await sharedJj.checkpointer.checkpointChange(active.handle);
      return result(outcome.kind === "completed" ? `Checkpointed ${outcome.receipt.changedPaths.length} path(s) into ${outcome.receipt.checkpointedChangeId}.` : `Shared checkpoint stopped: ${outcome.blocker.kind}.`, outcome);
    },
  });

  pi.registerTool({
    name: "assign_workspace_change",
    label: "Assign Workspace Change",
    description: "Assign one semantic target Change ID inside an isolated workspace to a direct writable child.",
    parameters: Type.Object({ ownerContextId: Type.String(), description: Type.String({ minLength: 1, maxLength: 4096 }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireOrchestrator(currentAgent);
      const owner = await requireDirectChild(orchestrator, params.ownerContextId, ctx.sessionManager.getSessionId());
      const context = await contextStore.get(owner.id); if (!context?.workspaceId) throw new Error("Assigned workspace target requires a tracked isolated child.");
      const tracked = await isolatedJj.workspaces.get(context.workspaceId);
      if (tracked?.phase === "active" && tracked.writer.phase === "leased" && tracked.writer.ownerContextId === context.contextId) await isolatedJj.operations.releaseWriter(isolatedWorkspaceWriteLease(jjWorkspaceId(context.workspaceId), workspaceWriteLeaseId(tracked.writer.leaseId)));
      const targetChangeId = await isolatedJj.workspaceFileSets.assignTarget(jjWorkspaceId(context.workspaceId), { ownerContextId: context.contextId, description: changeDescription(params.description) });
      return result(`Assigned workspace target ${targetChangeId} to ${context.contextId}.`, { workspaceId: context.workspaceId, ownerContextId: context.contextId, targetChangeId });
    },
  });

  pi.registerTool({
    name: "acquire_workspace_file_set",
    label: "Acquire Workspace File Set",
    description: "Acquire one complete canonical path set inside this isolated workspace; disjoint writers may proceed concurrently.",
    parameters: Type.Object({ paths: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 128 }) }),
    async execute(_id, params, signal) {
      if (mode !== "child" || !childDelegation) throw new Error("Workspace file claims are available only to delegated isolated contexts.");
      const context = await contextStore.get(childDelegation.id); if (!context?.workspaceId) throw new Error("This context has no tracked isolated workspace.");
      const claim = await isolatedJj.workspaceFileSets.acquire(jjWorkspaceId(context.workspaceId), { ownerContextId: context.contextId, paths: params.paths, signal });
      const active = await isolatedJj.workspaceFileSets.requireActive(claim);
      return result(`Acquired workspace claim ${claim.claimId}.`, { workspaceId: context.workspaceId, claimId: claim.claimId, paths: active.record.paths, targetChangeId: active.record.targetChangeId });
    },
  });

  pi.registerTool({
    name: "release_workspace_file_set",
    label: "Release Workspace File Set",
    description: "Release this context's unused isolated-workspace file set.",
    parameters: Type.Object({}),
    async execute() {
      if (mode !== "child" || !childDelegation) throw new Error("Workspace file claims are available only to delegated isolated contexts.");
      const context = await contextStore.get(childDelegation.id); if (!context?.workspaceId) throw new Error("This context has no tracked isolated workspace.");
      const active = await isolatedJj.workspaceFileSets.activeForOwner(jjWorkspaceId(context.workspaceId), context.contextId); if (!active) throw new Error("This context has no active workspace file-set claim.");
      await isolatedJj.workspaceFileSets.releaseUnused(active.handle);
      return result(`Released workspace claim ${active.handle.claimId}.`, { workspaceId: context.workspaceId, claimId: active.handle.claimId });
    },
  });

  pi.registerTool({
    name: "checkpoint_workspace_file_set",
    label: "Checkpoint Workspace File Set",
    description: "Checkpoint only this context's claimed isolated-workspace paths into its assigned target and release the claim.",
    parameters: Type.Object({}),
    async execute() {
      if (mode !== "child" || !childDelegation) throw new Error("Workspace file checkpointing is available only to delegated isolated contexts.");
      const context = await contextStore.get(childDelegation.id); if (!context?.workspaceId) throw new Error("This context has no tracked isolated workspace.");
      const active = await isolatedJj.workspaceFileSets.activeForOwner(jjWorkspaceId(context.workspaceId), context.contextId); if (!active) throw new Error("This context has no active workspace file-set claim.");
      const outcome = await isolatedJj.workspaceFileCheckpointer.checkpoint(jjWorkspaceId(context.workspaceId), checkpointableFileSetClaim(fileSetClaimId(active.handle.claimId)));
      return result(outcome.kind === "completed" ? `Checkpointed ${outcome.receipt.changedPaths.length} workspace path(s).` : `Workspace file checkpoint stopped: ${outcome.blocker.kind}.`, outcome);
    },
  });

  pi.registerTool({
    name: "workspace_checkpoint",
    label: "Workspace Checkpoint",
    description: "Checkpoint the current coherent isolated-workspace change and continue on one fresh empty head.",
    parameters: Type.Object({ description: Type.String({ minLength: 1, maxLength: 4096 }) }),
    async execute(_id, params) {
      if (mode !== "child" || !childDelegation) throw new Error("workspace_checkpoint is available only inside a tracked isolated child.");
      await isolatedReady;
      const context = await contextStore.get(childDelegation.id);
      if (!context?.workspaceId) throw new Error("This child has no tracked isolated workspace.");
      const tracked = await isolatedJj.workspaces.get(context.workspaceId);
      if (!tracked || tracked.phase !== "active" || tracked.writer.phase !== "leased" || tracked.writer.ownerContextId !== context.contextId) throw new Error("This context does not hold the workspace writer lease.");
      const lease = isolatedWorkspaceWriteLease(jjWorkspaceId(context.workspaceId), workspaceWriteLeaseId(tracked.writer.leaseId));
      const outcome = await isolatedJj.operations.checkpointWorkspace(lease, { description: changeDescription(params.description) });
      return result(outcome.kind === "completed" ? `Checkpointed ${outcome.receipt.checkpointedChangeId}; fresh head ${outcome.receipt.newHeadChangeId}.` : `Workspace checkpoint stopped: ${outcome.blocker.kind}.`, outcome);
    },
  });

  pi.registerTool({
    name: "normalize_change_range",
    label: "Normalize Change Range",
    description: "Remove safe interior empty changes and semantically name exact owned changes before report freeze.",
    parameters: Type.Object({ delegationId: Type.String(), descriptions: Type.Optional(Type.Array(Type.Object({ changeId: Type.String(), description: Type.String() }))) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireWorkspaceThinker(currentAgent);
      const child = await requireDirectChild(orchestrator, params.delegationId, ctx.sessionManager.getSessionId());
      const context = await contextStore.get(child.id); if (!context?.workspaceId) throw new Error("Delegation has no tracked workspace.");
      const tracked = await isolatedJj.workspaces.get(context.workspaceId);
      if (tracked?.phase === "active" && tracked.writer.phase === "leased" && tracked.writer.ownerContextId === child.id) {
        if (!["completed", "blocked", "failed", "cancelled"].includes(context.execution.phase)) throw new Error("Workspace child writer is not terminal.");
        await isolatedJj.operations.releaseWriter(isolatedWorkspaceWriteLease(jjWorkspaceId(context.workspaceId), workspaceWriteLeaseId(tracked.writer.leaseId)));
      }
      const outcome = await isolatedJj.operations.normalizeChangeRange(jjWorkspaceId(context.workspaceId), (params.descriptions ?? []).map((item) => ({ changeId: item.changeId, description: changeDescription(item.description) })));
      return result(outcome.kind === "completed" ? `Normalized tracked workspace ${context.workspaceId}.` : `Normalization stopped: ${outcome.blocker.kind}.`, outcome);
    },
  });

  pi.registerTool({
    name: "prepare_workspace_report",
    label: "Prepare Workspace Report",
    description: "Freeze a settled tracked workspace and derive its exact review boundary or no-change proof.",
    parameters: Type.Object({ delegationId: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireWorkspaceThinker(currentAgent);
      const child = await requireDirectChild(orchestrator, params.delegationId, ctx.sessionManager.getSessionId()); const context = await contextStore.get(child.id); if (!context?.workspaceId) throw new Error("Delegation has no tracked workspace.");
      const tracked = await isolatedJj.workspaces.get(context.workspaceId);
      if (tracked?.phase === "active" && tracked.writer.phase === "leased" && tracked.writer.ownerContextId === child.id) {
        if (!["completed", "blocked", "failed", "cancelled"].includes(context.execution.phase)) throw new Error("Workspace child writer is not terminal.");
        await isolatedJj.operations.releaseWriter(isolatedWorkspaceWriteLease(jjWorkspaceId(context.workspaceId), workspaceWriteLeaseId(tracked.writer.leaseId)));
      }
      const outcome = await isolatedJj.operations.prepareWorkspaceReport(jjWorkspaceId(context.workspaceId));
      return result(outcome.kind === "completed" ? `Frozen workspace report (${outcome.receipt.range}).` : `Report freeze stopped: ${outcome.blocker.kind}.`, outcome);
    },
  });

  pi.registerTool({
    name: "rebase_workspace",
    label: "Rebase Workspace",
    description: "Explicitly rebase a settled tracked workspace onto source @- or one exact local Change ID.",
    parameters: Type.Object({ delegationId: Type.String(), targetChangeId: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireWorkspaceThinker(currentAgent);
      const child = await requireDirectChild(orchestrator, params.delegationId, ctx.sessionManager.getSessionId()); const context = await contextStore.get(child.id); if (!context?.workspaceId) throw new Error("Delegation has no tracked workspace.");
      const outcome = await isolatedJj.operations.rebaseWorkspace(workspaceRebaseLease(jjWorkspaceId(context.workspaceId), workspaceWriteLeaseId(`rebase-${randomUUID()}`)), params.targetChangeId ? { kind: "exact_change", changeId: changeId(params.targetChangeId) } : { kind: "source_parent" });
      return result(outcome.kind === "completed" ? `Rebased workspace: ${outcome.receipt.disposition}.` : `Workspace rebase stopped: ${outcome.blocker.kind}.`, outcome);
    },
  });

  pi.registerTool({
    name: "prepare_workspace_review",
    label: "Prepare Workspace Review",
    description: "Acknowledge a frozen nonempty workspace, bind immutable task evidence, and launch an independent read-only reviewer.",
    parameters: Type.Object({ delegationId: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const caller = requireWorkspaceThinker(currentAgent); const child = await requireDirectChild(orchestrator, params.delegationId, ctx.sessionManager.getSessionId()); const implementation = await contextStore.get(child.id); if (!implementation?.workspaceId || !implementation.taskId) throw new Error("Implementation child must bind tracked workspace and task custody."); const terminal = [...implementation.events].reverse().find((event) => event.kind === "terminal" && event.delivery.phase === "acknowledged"); if (!terminal) throw new Error("Implementation terminal event must be acknowledged before review.");
      const tracked = await isolatedJj.workspaces.get(implementation.workspaceId); if (tracked?.phase === "reported") await isolatedJj.reviewCoordinator.acknowledge(jjWorkspaceId(implementation.workspaceId), { implementationEventId: terminal.eventId, taskId: implementation.taskId }); const afterAck = await isolatedJj.workspaces.get(implementation.workspaceId); if (afterAck?.phase === "closed_no_changes") return result("Workspace closed with proved no changes; review is unnecessary.", afterAck);
      const bundle = afterAck?.phase === "conflict_resolution" ? await isolatedJj.reviewCoordinator.prepareConflictReview(jjWorkspaceId(implementation.workspaceId)) : await isolatedJj.reviewCoordinator.prepareReview(jjWorkspaceId(implementation.workspaceId)); const reviewerAgent = loadCatalog(ctx).byName.get("reviewer"); if (!reviewerAgent) throw new Error("Reviewer agent is unavailable."); validateAgentTools(reviewerAgent, availableToolNames()); const reviewTask = await isolatedJj.tasks.assign(implementation.taskId, { ownerRole: "reviewer", creatorContextId: `thinker-${ctx.sessionManager.getSessionId()}`, objective: "Review the exact frozen workspace range against the immutable task snapshot", acceptanceCriteria: ["Submit structured p0-p4 findings", "Do not mutate files or JJ"] }); const reviewContextId = randomUUID();
      const reviewer = await spawnManagedChild({ contextId: reviewContextId, taskId: reviewTask.taskId, task: { objective: "Independently review the exact frozen workspace range", context: [`Review bundle ${bundle.bundleId}`, `Task snapshot ${bundle.taskSnapshot.path}`, `Exact range ${bundle.rootChangeId}::${bundle.contentTipChangeId}`, `Expected empty head ${bundle.workspaceHeadChangeId}`], resources: [{ type: "file", value: bundle.taskSnapshot.path, reason: "Immutable task snapshot" }], constraints: ["Read-only", "Use p0-p4 severity", "Call submit_workspace_review exactly once"], expectedOutput: "Structured review findings", uncertaintyHandling: "block" }, agent: reviewerAgent, caller, parentCwd: implementation.cwd, parentSessionId: ctx.sessionManager.getSessionId(), workspaceId: implementation.workspaceId, modelRegistry: ctx.modelRegistry }); await isolatedJj.tasks.bind(reviewTask.taskId, reviewer.id); await refreshChildWidget(ctx); return result(`Started reviewer ${reviewer.id} for ${bundle.bundleId}.`, { reviewer, bundle });
    },
  });

  pi.registerTool({
    name: "workspace_review_status",
    label: "Workspace Review Status",
    description: "Inspect the authoritative persisted review report, complete findings, dispositions, and approval eligibility for a workspace.",
    parameters: Type.Object({ workspaceId: Type.String() }),
    async execute(_id, params) {
      requireWorkspaceThinker(currentAgent);
      const status = await isolatedJj.reviewCoordinator.status(jjWorkspaceId(params.workspaceId));
      return result(`Inspected authoritative review state for ${params.workspaceId}.`, status);
    },
  });

  pi.registerTool({
    name: "submit_workspace_review",
    label: "Submit Workspace Review",
    description: "Submit one immutable structured p0-p4 report for the injected frozen workspace review.",
    parameters: Type.Object({ summary: Type.String(), validation: Type.Array(Type.String()), findings: Type.Array(Type.Object({ findingId: Type.String(), severity: StringEnum(["p0", "p1", "p2", "p3", "p4"] as const), relation: StringEnum(["introduced", "in_scope_existing", "out_of_scope_existing"] as const), summary: Type.String(), evidence: Type.String(), criterion: Type.Optional(Type.String()), changeIds: Type.Array(Type.String()), paths: Type.Array(Type.String()), suggestedCorrection: Type.Optional(Type.String()), focusedReviewable: Type.Boolean() })) }),
    async execute(_id, params) {
      if (mode !== "child" || currentAgent?.name !== "reviewer" || !childDelegation) throw new Error("Only an active reviewer may submit workspace review."); const context = await contextStore.get(childDelegation.id); if (!context?.workspaceId) throw new Error("Reviewer has no injected workspace."); const custody = await isolatedJj.workspaces.get(context.workspaceId); const report = custody?.phase === "conflict_resolution" ? await isolatedJj.reviewCoordinator.submitConflictReview(jjWorkspaceId(context.workspaceId), { reviewerContextId: context.contextId, summary: params.summary, validation: params.validation, findings: params.findings }) : await isolatedJj.reviewCoordinator.submitReview(jjWorkspaceId(context.workspaceId), { reviewerContextId: context.contextId, summary: params.summary, validation: params.validation, findings: params.findings }); return result(`Submitted review with ${report.findings.length} finding(s).`, report);
    },
  });

  pi.registerTool({
    name: "accept_workspace_review",
    label: "Accept Workspace Review",
    description: "Apply thinker dispositions to nonblocking findings and mint an immutable approval receipt.",
    parameters: Type.Object({ delegationId: Type.String(), dispositions: Type.Array(Type.Object({ findingId: Type.String(), disposition: StringEnum(["deferred", "not_applicable"] as const), rationale: Type.String() })) }),
    async execute(_id, params, _signal, _onUpdate, ctx) { requireWorkspaceThinker(currentAgent); const child = await requireDirectChild(orchestrator, params.delegationId, ctx.sessionManager.getSessionId()); const context = await contextStore.get(child.id); if (!context?.workspaceId) throw new Error("Delegation has no tracked workspace."); const custody = await isolatedJj.workspaces.get(context.workspaceId); const approval = custody?.phase === "conflict_resolution" ? await isolatedJj.reviewCoordinator.approveConflictReview(jjWorkspaceId(context.workspaceId), { thinkerContextId: `thinker-${ctx.sessionManager.getSessionId()}`, dispositions: params.dispositions }) : await isolatedJj.reviewCoordinator.approve(jjWorkspaceId(context.workspaceId), { thinkerContextId: `thinker-${ctx.sessionManager.getSessionId()}`, dispositions: params.dispositions }); return result(`Approved workspace review ${approval.reviewId}.`, approval); },
  });

  pi.registerTool({
    name: "begin_workspace_repair",
    label: "Begin Workspace Repair",
    description: "Thaw one changes-requested workspace for its single automatic repair cycle.",
    parameters: Type.Object({ delegationId: Type.String(), objective: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const caller = requireWorkspaceThinker(currentAgent); const child = await requireDirectChild(orchestrator, params.delegationId, ctx.sessionManager.getSessionId()); const context = await contextStore.get(child.id); if (!context?.workspaceId || !context.taskId) throw new Error("Delegation has no tracked workspace task.");
      const reviewStatus = await isolatedJj.reviewCoordinator.status(jjWorkspaceId(context.workspaceId)) as any;
      const findings = Array.isArray(reviewStatus.blockingFindings) ? reviewStatus.blockingFindings : [];
      const repairPaths: string[] = [...new Set<string>(findings.flatMap((finding: any) => Array.isArray(finding.paths) ? finding.paths.map(String) : []) as string[])].sort();
      if (!findings.length || !repairPaths.length) throw new Error("Workspace repair requires current blocking findings with exact affected paths.");
      await isolatedJj.reviewCoordinator.beginRepair(jjWorkspaceId(context.workspaceId));
      const worker = loadCatalog(ctx).byName.get("worker"); if (!worker) throw new Error("Worker agent is unavailable.");
      const repairTask = await isolatedJj.tasks.assign(context.taskId, { ownerRole: "worker", creatorContextId: `thinker-${ctx.sessionManager.getSessionId()}`, objective: params.objective ?? "Repair all blocking p0/p1 review findings", constraints: ["One bounded repair cycle", "Checkpoint only the assigned workspace file set"] });
      const repairContextId = randomUUID(); const repairAttemptId = `repair-${randomUUID()}`;
      const targetChangeId = await isolatedJj.workspaceFileSets.assignTarget(jjWorkspaceId(context.workspaceId), { ownerContextId: repairContextId, description: changeDescription("fix: address workspace review findings") });
      const claim = await isolatedJj.workspaceFileSets.acquire(jjWorkspaceId(context.workspaceId), { ownerContextId: repairContextId, paths: repairPaths });
      try {
        const repair = await spawnManagedChild({ contextId: repairContextId, taskId: repairTask.taskId, task: { objective: params.objective ?? "Repair all blocking workspace review findings", context: [`Review ${reviewStatus.reviewId}`, ...findings.map((finding: any) => `${finding.findingId}: ${finding.summary} — ${finding.evidence}`)], resources: repairPaths.map((path) => ({ type: "file" as const, value: path, reason: "Blocking review finding" })), constraints: ["One repair cycle", "Call checkpoint_workspace_file_set", `Modify only: ${repairPaths.join(", ")}`], expectedOutput: "Validated focused repair", uncertaintyHandling: "ask-parent" }, agent: worker, caller, parentCwd: context.cwd, parentSessionId: ctx.sessionManager.getSessionId(), workspaceId: context.workspaceId, modelRegistry: ctx.modelRegistry });
        const launched = await contextStore.get(repair.id); const active = await isolatedJj.workspaceFileSets.activeForOwner(jjWorkspaceId(context.workspaceId), repairContextId);
        if (!launched || launched.execution.phase !== "running" || !active || active.handle.claimId !== claim.claimId) throw new Error("Repair runtime and workspace claim did not become active together.");
        await isolatedJj.tasks.bind(repairTask.taskId, repair.id);
        const receipt = { repairAttemptId, taskId: repairTask.taskId, contextId: repair.id, executionCycleId: launched.execution.cycleId, workspaceId: context.workspaceId, reviewId: reviewStatus.reviewId, claimId: claim.claimId, targetChangeId, paths: repairPaths };
        return result(`Started repair worker ${repair.id} in ${context.workspaceId}.`, { child: repair, repairReceipt: receipt });
      } catch (error) { await isolatedJj.workspaceFileSets.interrupt(jjWorkspaceId(context.workspaceId), "repair child startup failed"); throw error; }
    },
  });

  pi.registerTool({
    name: "workspace_subagent",
    label: "Workspace Subagent",
    description: "Create an isolated JJ workspace and launch a planner or worker there. Only the root thinker may call this tool.",
    promptSnippet: "Launch a planner or worker in an isolated JJ workspace",
    promptGuidelines: [
      "Use workspace_subagent only from the root thinker and choose planner for decomposition or worker for bounded implementation.",
      "Launching a workspace child is not completion. Use await_child_event for its pushed terminal event, acknowledge it, freeze it, independently review every nonempty range, and integrate only with an approval receipt.",
      "workspace_subagent branches from source @- while source @ may contain ongoing work; creation does not move or rewrite source files.",
    ],
    parameters: Type.Object({
      agent: StringEnum(["planner", "worker"] as const),
      taskId: Type.Optional(Type.String({ description: "Durable task assignment to bind" })),
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
      if (dependencies.workspace && !dependencies.isolatedJj) {
        const attachment = await workspace.create({ cwd: ctx.cwd, name, purpose: "delegation" });
        const record = await spawnManagedChild({ task: params.task, agent: target, caller, ...(params.taskId ? { taskId: params.taskId } : {}), parentCwd: attachment.path, parentSessionId: ctx.sessionManager.getSessionId(), workspace: attachment, modelRegistry: ctx.modelRegistry });
        if (params.taskId) await isolatedJj.tasks.bind(params.taskId, record.id);
        await refreshChildWidget(ctx);
        return result(`Spawned ${target.name} ${record.id} in JJ workspace ${attachment.path}.`, record);
      }
      await isolatedReady;
      const source = await isolatedJj.shared.openSource(ctx.cwd);
      const ensured = await isolatedJj.shared.operations.ensureWip(source);
      if (ensured.kind !== "completed") throw new Error(`Workspace allocation stopped: ${ensured.blocker.kind}.`);
      const contextId = randomUUID();
      const created = await isolatedJj.operations.createWorkspace(source, {
        name: jjWorkspaceName(name),
        ownerContextId: contextId,
        rootSessionId: authoritativeRootSessionId(ctx),
      });
      if (created.kind !== "completed") throw new Error(`Workspace allocation stopped: ${created.blocker.kind}.`);
      const sourceState = await isolatedJj.shared.store.get(source.sourceId);
      const tracked = await isolatedJj.workspaces.get(created.receipt.workspaceId);
      if (!sourceState || tracked?.phase !== "active") throw new Error("Tracked workspace state disappeared after allocation.");
      const attachment: WorkspaceAttachment = {
        backend: "jj", purpose: "delegation", repoRoot: sourceState.workspacePath,
        sourceWorkspace: sourceState.workspaceName, sourcePath: sourceState.workspacePath,
        baseChangeId: tracked.identity.baseChangeId, name: tracked.identity.name,
        path: tracked.identity.path, rootChangeId: tracked.identity.rootChangeId,
      };
      let record: DelegationRecord;
      try {
        record = await spawnManagedChild({
          task: params.task, agent: target, caller, contextId,
          ...(params.taskId ? { taskId: params.taskId } : {}),
          parentCwd: created.receipt.path,
          parentSessionId: ctx.sessionManager.getSessionId(),
          workspaceId: created.receipt.workspaceId,
          workspace: attachment,
          modelRegistry: ctx.modelRegistry,
        });
      } catch (error) {
        await isolatedJj.workspaces.interruptLiveWriters(created.receipt.workspaceId, "child startup failed");
        throw error;
      }
      if (params.taskId) await isolatedJj.tasks.bind(params.taskId, record.id);
      const launched = await contextStore.get(record.id);
      const launchReceipt = { taskId: launched?.taskId, contextId: record.id, parentContextId: launched?.parentContextId, executionCycleId: launched?.execution.cycleId, workspaceId: created.receipt.workspaceId, workspacePath: created.receipt.path, rootChangeId: created.receipt.rootChangeId, workspaceHeadChangeId: created.receipt.workspaceHeadChangeId, operationId: created.receipt.operationId };
      await refreshChildWidget(ctx);
      return result(`Spawned ${target.name} ${record.id} in tracked JJ workspace ${created.receipt.path}.`, { child: record, launchReceipt });
    },
  });

  pi.registerTool({
    name: "integrate_workspace",
    label: "Integrate Workspace",
    description: "Integrate only an approved tracked workspace range before source WIP through persisted deterministic phases; legacy records use compatibility integration.",
    promptGuidelines: [
      "Tracked integration requires an accepted matching review receipt and preserves exact approved identities and patches.",
      "Integration permits a dirty source WIP and preserves its Change ID and file content; verification and closure remain separate.",
    ],
    parameters: Type.Object({ delegationId: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireWorkspaceThinker(currentAgent);
      const child = await requireDirectChild(orchestrator, params.delegationId, ctx.sessionManager.getSessionId());
      const trackedContext = await contextStore.get(child.id);
      if (trackedContext?.workspaceId) {
        const receipt = await isolatedJj.integration.integrate(jjWorkspaceId(trackedContext.workspaceId));
        return result(receipt.conflicted ? `Integrated approved range with owned conflicts requiring repair: ${receipt.conflictPaths.join(", ")}.` : `Integrated approved range ${receipt.integratedChangeIds.join(", ")}.`, receipt);
      }
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
    name: "squash_resolution",
    label: "Squash Conflict Resolution",
    description: "Squash exact resolved conflict paths from source WIP into their uniquely owning integrated changes.",
    parameters: Type.Object({ delegationId: Type.String(), paths: Type.Array(Type.String(), { minItems: 1 }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) { requireWorkspaceThinker(currentAgent); const child = await requireDirectChild(orchestrator, params.delegationId, ctx.sessionManager.getSessionId()); const context = await contextStore.get(child.id); if (!context?.workspaceId) throw new Error("Delegation has no tracked workspace."); const lease = conflictResolutionLease(jjWorkspaceId(context.workspaceId), fileSetClaimId(`conflict-${randomUUID()}`)); const receipt = await isolatedJj.conflicts.squashResolution(lease, params.paths); return result(`Squashed ${receipt.resolvedPaths.length} resolved conflict path(s); focused re-review is required.`, receipt); },
  });

  pi.registerTool({
    name: "verify_integrated_range",
    label: "Verify Integrated Range",
    description: "Verify exact JJ integration evidence and persist separate product acceptance evidence.",
    parameters: Type.Object({ delegationId: Type.String(), productChecks: Type.Array(Type.String(), { minItems: 1 }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) { requireWorkspaceThinker(currentAgent); const child = await requireDirectChild(orchestrator, params.delegationId, ctx.sessionManager.getSessionId()); const context = await contextStore.get(child.id); if (!context?.workspaceId) throw new Error("Delegation has no tracked workspace."); const receipt = await isolatedJj.closure.verify(jjWorkspaceId(context.workspaceId), params.productChecks); return result(`Verified integrated workspace ${context.workspaceId}.`, receipt); },
  });

  pi.registerTool({
    name: "close_workspace",
    label: "Close Workspace",
    description: "Close semantically integrated workspace custody after JJ and product verification.",
    parameters: Type.Object({ delegationId: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) { requireWorkspaceThinker(currentAgent); const child = await requireDirectChild(orchestrator, params.delegationId, ctx.sessionManager.getSessionId()); const context = await contextStore.get(child.id); if (!context?.workspaceId) throw new Error("Delegation has no tracked workspace."); await isolatedJj.closure.close(jjWorkspaceId(context.workspaceId)); return result(`Closed workspace custody ${context.workspaceId}.`, { workspaceId: context.workspaceId }); },
  });

  pi.registerTool({
    name: "workspace_custody_status",
    label: "Workspace Custody Status",
    description: "Inspect expected and observed JJ custody facts for one tracked workspace in any lifecycle phase.",
    parameters: Type.Object({ workspaceId: Type.String() }),
    async execute(_id, params) {
      requireWorkspaceThinker(currentAgent);
      const snapshot = await isolatedJj.recoveryInspector.inspect(jjWorkspaceId(params.workspaceId));
      return result(`Workspace ${params.workspaceId} is ${snapshot.custodyPhase} with ${snapshot.discrepancies.length} discrepancy(s).`, snapshot);
    },
  });

  pi.registerTool({
    name: "workspace_recovery_plan",
    label: "Workspace Recovery Plan",
    description: "Classify current workspace custody facts and return every proved next recovery action without mutating JJ.",
    parameters: Type.Object({ workspaceId: Type.String() }),
    async execute(_id, params) {
      requireWorkspaceThinker(currentAgent);
      const snapshot = await isolatedJj.recoveryInspector.inspect(jjWorkspaceId(params.workspaceId));
      const plan = isolatedJj.recoveryPlanner.plan(snapshot);
      return result(`Recovery disposition for ${params.workspaceId}: ${plan.disposition}.`, { snapshot, plan });
    },
  });

  pi.registerTool({
    name: "resume_workspace_operation",
    label: "Resume Workspace Operation",
    description: "Resume only the next proved integration boundary using the latest sourced user direction.",
    parameters: Type.Object({ delegationId: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) { requireWorkspaceThinker(currentAgent); const child = await requireDirectChild(orchestrator, params.delegationId, ctx.sessionManager.getSessionId()); const context = await contextStore.get(child.id); if (!context?.workspaceId) throw new Error("Delegation has no tracked workspace."); const authorization = { authorizationId: `recovery-${randomUUID()}`, workspaceId: context.workspaceId, action: "resume_operation" as const, userEvidence: latestUserEvidence(ctx), createdAt: new Date().toISOString() }; const receipt = await isolatedJj.closure.resume(jjWorkspaceId(context.workspaceId), authorization); return result(`Resumed workspace operation ${context.workspaceId}.`, receipt); },
  });

  pi.registerTool({
    name: "rebind_tracked_change",
    label: "Rebind Tracked Change",
    description: "Adopt one exact connected replacement Change ID under sourced user recovery authority.",
    parameters: Type.Object({ delegationId: Type.String(), kind: StringEnum(["root", "head"] as const), replacementChangeId: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) { requireWorkspaceThinker(currentAgent); const child = await requireDirectChild(orchestrator, params.delegationId, ctx.sessionManager.getSessionId()); const context = await contextStore.get(child.id); if (!context?.workspaceId) throw new Error("Delegation has no tracked workspace."); const authorization = { authorizationId: `recovery-${randomUUID()}`, workspaceId: context.workspaceId, action: "rebind_change" as const, userEvidence: latestUserEvidence(ctx), createdAt: new Date().toISOString() }; const receipt = await isolatedJj.closure.rebind(jjWorkspaceId(context.workspaceId), { kind: params.kind, replacementChangeId: params.replacementChangeId, authorization }); return result(`Rebound tracked ${params.kind} under user authority.`, receipt); },
  });

  pi.registerTool({
    name: "retry_workspace_cleanup",
    label: "Retry Workspace Cleanup",
    description: "Retry only the exact recorded cleanup under sourced user recovery authority.",
    parameters: Type.Object({ delegationId: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) { requireWorkspaceThinker(currentAgent); const child = await requireDirectChild(orchestrator, params.delegationId, ctx.sessionManager.getSessionId()); const context = await contextStore.get(child.id); if (!context?.workspaceId) throw new Error("Delegation has no tracked workspace."); const authorization = { authorizationId: `recovery-${randomUUID()}`, workspaceId: context.workspaceId, action: "retry_cleanup" as const, userEvidence: latestUserEvidence(ctx), createdAt: new Date().toISOString() }; await isolatedJj.closure.retryCleanup(jjWorkspaceId(context.workspaceId), authorization); return result(`Retried exact cleanup for ${context.workspaceId}.`, { workspaceId: context.workspaceId }); },
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
      if (coordinator?.getRuntime(params.delegationId)) {
        await coordinator.message(params.delegationId, {
          customType: "pi-tai-parent-message-v1",
          content: params.message,
          details: { kind: "instruction", content: params.message },
          delivery: params.delivery ?? "steer",
          triggerTurn: true,
        });
        const record = await orchestrator.child(params.delegationId);
        return result(`Sent ${params.delivery ?? "steer"} message to ${record.id}.`, record);
      }
      const record = await orchestrator.message(params.delegationId, params.message, params.delivery ?? "steer");
      return result(`Sent ${params.delivery ?? "steer"} message to ${record.id}.`, record);
    },
  });

  pi.registerTool({
    name: "reconcile_children",
    label: "Reconcile Children",
    description: "Reconcile the durable child tree post-order and resume only safe quiescent contexts.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      requireOrchestrator(currentAgent);
      if (!reconciler) return result("No in-process child contexts require reconciliation.", []);
      const rootSessionId = authoritativeRootSessionId(ctx);
      const reconciled = await reconciler.reconcile({
        rootSessionId,
        modelRegistry: ctx.modelRegistry,
        extensions: childRuntimeExtensions,
      });
      const summary = reconciled.length
        ? reconciled.map((item) => `${"  ".repeat(item.depth)}${item.contextId}: ${item.disposition}`).join("\n")
        : "No durable child contexts.";
      return result(`Reconciled children post-order.\n${summary}`, reconciled);
    },
  });

  pi.registerTool({
    name: "ack_child_event",
    label: "Acknowledge Child Event",
    description: "Acknowledge one delivered child event without reading child history.",
    parameters: Type.Object({
      contextId: Type.String(),
      eventId: Type.String(),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireOrchestrator(currentAgent);
      await requireDirectChild(orchestrator, params.contextId, ctx.sessionManager.getSessionId());
      if (!protocol) throw new Error("Typed child event protocol is unavailable.");
      const event = await protocol.acknowledge(params.contextId, params.eventId);
      let attributedUsage: ReturnType<typeof usageFromTotals> | undefined;
      if (event.kind === "terminal") {
        const totals = await usageLedger.totals(authoritativeRootSessionId(ctx), params.contextId);
        const attributedAt = new Date().toISOString();
        let shouldAttributeUsage = false;
        const legacy = await store.update(params.contextId, (record) => {
          shouldAttributeUsage = !record.usageAttributedAt;
          return {
            ...record,
            parentCollectedAt: record.parentCollectedAt ?? attributedAt,
            usageAttributedAt: record.usageAttributedAt ?? attributedAt,
          };
        });
        if (shouldAttributeUsage) attributedUsage = usageFromTotals(totals.total);
        const terminalContext = await contextStore.get(params.contextId);
        if (terminalContext?.workspaceId) {
          const tracked = await isolatedJj.workspaces.get(terminalContext.workspaceId);
          if (tracked?.phase === "active" && tracked.writer.phase === "leased" && tracked.writer.ownerContextId === terminalContext.contextId) {
            const lease = isolatedWorkspaceWriteLease(jjWorkspaceId(terminalContext.workspaceId), workspaceWriteLeaseId(tracked.writer.leaseId));
            const parentContext = terminalContext.parentContextId ? await contextStore.get(terminalContext.parentContextId) : undefined;
            if (parentContext?.workspaceId === terminalContext.workspaceId) await isolatedJj.operations.transferWriter(lease, parentContext.contextId);
            else await isolatedJj.operations.releaseWriter(lease);
          }
          const claim = await isolatedJj.workspaceFileSets.activeForOwner(jjWorkspaceId(terminalContext.workspaceId), terminalContext.contextId);
          if (claim) {
            try { await isolatedJj.workspaceFileSets.releaseUnused(claim.handle); }
            catch { await isolatedJj.workspaceFileSets.interrupt(jjWorkspaceId(terminalContext.workspaceId), "terminal context retained uncheckpointed workspace paths"); }
          }
        }
        if (!legacy.workspace && !coordinator?.getRuntime(params.contextId)) await retention.closeClean(params.contextId, true);
      }
      return {
        ...result(`Acknowledged ${event.kind} event ${event.eventId}.`, event),
        ...(attributedUsage ? { usage: attributedUsage } : {}),
      };
    },
  });

  pi.registerTool({
    name: "await_child_event",
    label: "Await Child Event",
    description: "Suspend without polling until one direct-child event, cancellation, timeout, or interactive user input.",
    parameters: Type.Object({
      contextIds: Type.Optional(Type.Array(Type.String(), { maxItems: 64 })),
      kinds: Type.Optional(Type.Array(StringEnum(["question", "status", "terminal", "incident"] as const), { maxItems: 4 })),
      timeoutMs: Type.Optional(Type.Number({ minimum: 1, maximum: 300_000 })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      requireOrchestrator(currentAgent);
      const direct = await orchestrator.children(ctx.sessionManager.getSessionId());
      const selectedIds = params.contextIds ?? direct.map((record) => record.id);
      for (const id of selectedIds) await requireDirectChild(orchestrator, id, ctx.sessionManager.getSessionId());
      const kinds = new Set<"question" | "status" | "terminal" | "incident">(
        params.kinds ?? ["question", "terminal", "incident"],
      );
      for (const contextId of selectedIds) {
        const context = await contextStore.get(contextId);
        const existing = context?.events.find((event) => event.delivery.phase === "delivered" && kinds.has(event.kind));
        if (existing) return result(`Received ${existing.kind} event ${existing.eventId} from ${contextId}.`, existing);
      }
      const callerId = childDelegation?.id ?? ctx.sessionManager.getSessionId();
      const waited = await waits.wait({
        callerId,
        contextIds: selectedIds,
        kinds: [...kinds],
        signal,
        ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
      });
      return waited.reason === "event"
        ? result(`Received ${waited.event.kind} event ${waited.event.eventId} from ${waited.event.contextId}.`, waited.event)
        : result(`Child-event wait ended: ${waited.reason}.`, waited);
    },
  });

  if (!dependencies.config) pi.registerTool({
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
      if (protocol) {
        for (const record of records) {
          const context = await contextStore.get(record.id);
          if (!context || !["completed", "blocked", "failed", "cancelled"].includes(context.execution.phase)) continue;
          const terminalId = "terminalEventId" in context.execution ? context.execution.terminalEventId : undefined;
          const terminal = terminalId ? context.events.find((event) => event.eventId === terminalId) : undefined;
          if (terminal?.delivery.phase === "delivered") await protocol.acknowledge(record.id, terminal.eventId);
        }
      }
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

  if (!dependencies.config) pi.registerTool({
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
    name: "request_child_status",
    label: "Request Child Status",
    description: "Request one fresh bounded semantic status turn, optionally with a focus and additional asks, without reading child history.",
    parameters: Type.Object({
      contextId: Type.String(),
      focus: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
      questions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { maxItems: 8 })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireOrchestrator(currentAgent);
      await requireDirectChild(orchestrator, params.contextId, ctx.sessionManager.getSessionId());
      if (!coordinator?.getRuntime(params.contextId)) throw new Error("Child has no active SDK runtime.");
      const requestId = randomUUID();
      const focus = params.focus ? `\nFocus: ${params.focus}` : "";
      const questions = params.questions?.length
        ? `\nAdditional asks:\n${params.questions.map((question) => `- ${question}`).join("\n")}`
        : "";
      await coordinator.message(params.contextId, {
        customType: "pi-tai-parent-message-v1",
        content: `Provide bounded status for request ${requestId}, then continue your prior work.${focus}${questions}`,
        details: {
          kind: "status_request",
          requestId,
          ...(params.focus ? { focus: params.focus } : {}),
          ...(params.questions ? { questions: params.questions } : {}),
        },
        delivery: "steer",
        triggerTurn: true,
      });
      return result(`Requested status ${requestId} from ${params.contextId}.`, { requestId, contextId: params.contextId });
    },
  });

  pi.registerTool({
    name: "concurrency_usage",
    label: "Concurrency Usage",
    description: "Return authoritative side-ledger usage totals by model, role, context, and execution cycle.",
    parameters: Type.Object({ contextId: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireOrchestrator(currentAgent);
      if (params.contextId) await requireDirectChild(orchestrator, params.contextId, ctx.sessionManager.getSessionId());
      const rootSessionId = authoritativeRootSessionId(ctx);
      const totals = await usageLedger.totals(rootSessionId, params.contextId);
      return result(`Child usage: ${totals.total.input + totals.total.output + totals.total.cacheRead + totals.total.cacheWrite} tokens · $${totals.total.cost.toFixed(4)}.`, totals);
    },
  });

  if (!dependencies.config) pi.registerTool({
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
      const direct = await requireDirectChild(orchestrator, params.delegationId, ctx.sessionManager.getSessionId());
      if (protocol && await contextStore.get(params.delegationId)) {
        await protocol.answerQuestion(params.delegationId, params.questionId, params.response);
        const record = direct.execution.phase === "awaiting_parent"
          ? await orchestrator.respond(params.delegationId, direct.execution.question.id, params.response)
          : direct;
        return result(`Answered ${params.questionId} for ${record.id}.`, record);
      }
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
      if (coordinator?.getRuntime(params.delegationId)) {
        const cancellation = await coordinator.cancel(params.delegationId);
        const context = cancellation.contexts.find((candidate) => candidate.contextId === params.delegationId);
        if (!context) throw new Error(`Cancellation lost child context ${params.delegationId}.`);
        const record = await store.update(params.delegationId, (current) => context.execution.phase === "cancelled"
          ? {
              ...current,
              execution: { phase: "cancelled", report: { outcome: "cancelled", summary: "Cancelled by parent.", reportedAt: context.execution.finishedAt } },
            }
          : context.execution.phase === "cancelling"
            ? { ...current, execution: { phase: "running", activity: "Cancellation requested; waiting for runtime quiescence." } }
            : current);
        await refreshChildWidget(ctx);
        return cancellation.disposition === "pending"
          ? result(`Cancellation requested for child ${record.id}; still settling: ${cancellation.pendingContextIds.join(", ")}. Workspace custody was preserved.`, cancellation)
          : cancellation.disposition === "already_terminal"
            ? result(`Child ${record.id} was already terminal (${context.execution.phase}); no cancellation was applied.`, cancellation)
            : result(`Cancelled child ${record.id}; workspace custody was preserved.`, cancellation);
      }
      const record = await orchestrator.abandon(params.delegationId);
      await refreshChildWidget(ctx);
      return result(`Abandoned child ${record.id}; shared files were left untouched.`, record);
    },
  });

  pi.registerTool({
    name: "message_parent",
    label: "Message Parent",
    description: "Push a bounded typed status or incident event to the direct parent.",
    parameters: Type.Object({
      kind: StringEnum(["status", "incident"] as const),
      summary: Type.String({ minLength: 1, maxLength: 4_000 }),
    }),
    async execute(_id, params) {
      if (mode !== "child" || !childDelegation) throw new Error("message_parent requires a delegated child.");
      const event = params.kind === "status"
        ? await emitChildEvent({ kind: "status", requestId: randomUUID(), summary: params.summary })
        : await emitChildEvent({ kind: "incident", reason: params.summary, recoveryDisposition: "retryable" });
      if (!event) throw new Error("Typed child event protocol is unavailable.");
      return result(`Pushed ${params.kind} event ${event.eventId}.`, event);
    },
  });

  pi.registerTool({
    name: "report_status",
    label: "Report Status",
    description: "Submit a non-terminal status response and continue the current delegated task.",
    promptGuidelines: [
      "Use report_status only for the request ID supplied by a status request, then resume prior work and return to await_child_event if children remain outstanding.",
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
      await emitChildEvent({ kind: "status", ...params });
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
      await emitChildEvent({
        kind: "question",
        question: params.question,
        ...(params.options ? { options: params.options } : {}),
        ...(params.recommendation ? { recommendation: params.recommendation } : {}),
      });
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
      "Before report_to_parent, repeatedly use await_child_event, handle questions, and acknowledge every direct-child terminal event.",
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
      await emitChildEvent({ kind: "terminal", ...params });
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

function requireSharedWorker(
  agent: AgentDefinition | undefined,
  delegation: DelegationRecord | undefined,
): DelegationRecord {
  if (agent?.name !== "worker" || !delegation || delegation.workspace) {
    throw new Error("Shared file-set tools require a non-workspace worker context.");
  }
  return delegation;
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

function usageFromTotals(totals: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }) {
  return {
    input: totals.input,
    output: totals.output,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    totalTokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totals.cost },
  };
}

function projectContextDelegation(context: PersistedChildContextV4, parentSessionId: string): DelegationRecord {
  const terminalEventId = "terminalEventId" in context.execution ? context.execution.terminalEventId : undefined;
  const questionEventId = context.execution.phase === "awaiting_parent" ? context.execution.questionEventId : undefined;
  const terminal = terminalEventId ? context.events.find((event) => event.eventId === terminalEventId) : undefined;
  const terminalPayload = terminal?.payload as Record<string, any> | undefined;
  const execution: DelegationRecord["execution"] = context.execution.phase === "created" || context.execution.phase === "starting"
    ? { phase: "created" }
    : context.execution.phase === "running" || context.execution.phase === "cancelling"
      ? { phase: "running", ...(context.execution.phase === "cancelling" ? { activity: "Cancellation requested; waiting for runtime quiescence." } : {}) }
      : context.execution.phase === "awaiting_parent"
        ? { phase: "awaiting_parent", question: { id: questionEventId!, question: String((context.events.find((event) => event.eventId === questionEventId)?.payload as any)?.question ?? "Awaiting parent"), askedAt: context.updatedAt } }
        : context.execution.phase === "incident" || context.execution.phase === "interrupted"
          ? { phase: "failed", report: { outcome: "failed", summary: context.execution.reason, reportedAt: "stoppedAt" in context.execution ? context.execution.stoppedAt : context.execution.interruptedAt } }
          : { phase: context.execution.phase, report: { outcome: context.execution.phase, summary: String(terminalPayload?.summary ?? `Child ${context.execution.phase}.`), ...(Array.isArray(terminalPayload?.validation) ? { validation: terminalPayload.validation } : {}), ...(Array.isArray(terminalPayload?.changedFiles) ? { changedFiles: terminalPayload.changedFiles } : {}), ...(Array.isArray(terminalPayload?.concerns) ? { concerns: terminalPayload.concerns } : {}), reportedAt: context.execution.finishedAt } };
  return {
    version: 3, id: context.contextId, parentSessionId, ...(context.parentContextId ? { parentDelegationId: context.parentContextId } : {}), cwd: context.cwd, task: context.task, agent: context.agent, execution,
    ...(context.execution.phase === "running" || context.execution.phase === "awaiting_parent" || context.execution.phase === "cancelling"
      ? { ...(context.execution.sessionId ? { childSessionId: context.execution.sessionId } : {}), ...(context.execution.sessionFile ? { childSessionFile: context.execution.sessionFile } : {}) }
      : {}),
    ...(terminal?.delivery.phase === "acknowledged" ? { parentCollectedAt: terminal.delivery.acknowledgedAt } : {}), createdAt: context.createdAt, updatedAt: context.updatedAt,
  };
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
