import { randomUUID } from "node:crypto";
import type { InlineExtension, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentDefinitionSnapshot } from "../subagents/store.ts";
import { renderTaskPacket, type ResolvedTaskPacket } from "../subagents/task.ts";
import type { WorkspaceAttachment } from "../workspaces/domain.ts";
import type { PrivateChildSessionFactoryPort, PrivateChildSessionHandle } from "./child-session.ts";
import type { ChildUsageLedger } from "./usage.ts";
import type {
  ChildContextStore,
  PersistedChildContextV4,
  PersistedChildEventV4,
} from "./persistence.ts";

type ModelRegistry = ExtensionContext["modelRegistry"];

export interface SpawnContextRequest {
  rootSessionId: string;
  parentContextId?: string;
  cwd: string;
  task: ResolvedTaskPacket;
  agent: AgentDefinitionSnapshot;
  caller: AgentDefinitionSnapshot;
  modelRegistry: ModelRegistry;
  contextId?: string;
  taskId?: string;
  workspaceId?: string;
  workspace?: WorkspaceAttachment;
  extensions?: readonly InlineExtension[] | ((contextId: string) => readonly InlineExtension[]);
  onPersisted?: (record: PersistedChildContextV4) => Promise<void>;
  onStarted?: (record: PersistedChildContextV4) => Promise<void>;
}

export interface ChildContextRuntime {
  readonly contextId: string;
  readonly cycleId: string;
  readonly handle: PrivateChildSessionHandle;
  readonly completion: Promise<void>;
  readonly unsubscribe: () => void;
}

export interface ChildContextCoordinatorOptions {
  store: ChildContextStore;
  sessionFactory: PrivateChildSessionFactoryPort;
  stateRoot: string;
  agentDir: string;
  now?: () => string;
  id?: () => string;
  usageLedger?: ChildUsageLedger;
  cancellationGraceMs?: number;
  onCancelled?: (context: PersistedChildContextV4) => void | Promise<void>;
}

export type ChildCancellationResult =
  | { disposition: "cancelled" | "already_terminal"; contexts: PersistedChildContextV4[]; pendingContextIds: [] }
  | { disposition: "pending"; contexts: PersistedChildContextV4[]; pendingContextIds: string[] };

export class ChildContextCoordinator {
  private readonly store: ChildContextStore;
  private readonly sessionFactory: PrivateChildSessionFactoryPort;
  private readonly stateRoot: string;
  private readonly agentDir: string;
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly usageLedger?: ChildUsageLedger;
  private readonly cancellationGraceMs: number;
  private readonly onCancelled?: (context: PersistedChildContextV4) => void | Promise<void>;
  private readonly runtimes = new Map<string, ChildContextRuntime>();
  private readonly cancellations = new Map<string, Promise<void>>();

  constructor(options: ChildContextCoordinatorOptions) {
    this.store = options.store;
    this.sessionFactory = options.sessionFactory;
    this.stateRoot = options.stateRoot;
    this.agentDir = options.agentDir;
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? randomUUID;
    this.usageLedger = options.usageLedger;
    this.cancellationGraceMs = options.cancellationGraceMs ?? 1_000;
    this.onCancelled = options.onCancelled;
  }

  async spawn(request: SpawnContextRequest): Promise<PersistedChildContextV4> {
    if (!request.caller.allowedChildren.includes(request.agent.name)) {
      throw new Error(`Agent "${request.caller.name}" cannot create "${request.agent.name}".`);
    }
    const contextId = request.contextId ?? this.id();
    const cycleId = this.id();
    const timestamp = this.now();
    const record: PersistedChildContextV4 = {
      version: 4,
      contextId,
      rootSessionId: request.rootSessionId,
      ...(request.parentContextId ? { parentContextId: request.parentContextId } : {}),
      cwd: request.cwd,
      task: request.task,
      agent: request.agent,
      ...(request.taskId ? { taskId: request.taskId } : {}),
      ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
      ...(request.workspace ? { workspace: request.workspace } : {}),
      execution: { phase: "created", cycleId },
      events: [],
      usage: [],
      telemetryGaps: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.create(record);
    await request.onPersisted?.(record);
    await this.store.update(contextId, (current) => ({
      ...current,
      execution: { phase: "starting", cycleId, startedAt: timestamp },
      updatedAt: this.now(),
    }));
    try {
      const handle = await this.sessionFactory.create({
        contextId,
        cwd: request.cwd,
        stateRoot: this.stateRoot,
        agentDir: this.agentDir,
        agent: request.agent,
        modelRegistry: request.modelRegistry,
        systemPrompt: request.agent.systemPrompt,
        extensions: typeof request.extensions === "function" ? request.extensions(contextId) : request.extensions,
      });
      const started = await this.store.update(contextId, (current) => ({
        ...current,
        execution: {
          phase: "running",
          cycleId,
          startedAt: timestamp,
          sessionId: handle.sessionId,
          sessionFile: handle.sessionFile,
        },
        updatedAt: this.now(),
      }));
      await request.onStarted?.(started);
      const unsubscribe = handle.session.subscribe((event) => {
        if (event.type !== "message_end" || event.message.role !== "assistant" || !this.usageLedger) return;
        void this.usageLedger.recordAssistant({
          contextId,
          cycleId,
          role: request.agent.name,
          provider: request.agent.provider,
          model: request.agent.model,
          message: event.message,
        });
      });
      handle.send({
        customType: "pi-tai-task-v1",
        content: renderTaskPacket(request.task),
        details: { kind: "task", contextId, cycleId, task: request.task },
        delivery: "steer",
        triggerTurn: true,
      });
      const completion = handle.waitForIdle().catch(async (error) => {
        await this.recordIncident(contextId, cycleId, error instanceof Error ? error.message : String(error));
      });
      this.runtimes.set(contextId, { contextId, cycleId, handle, completion, unsubscribe });
      return (await this.store.get(contextId))!;
    } catch (error) {
      await this.recordIncident(contextId, cycleId, error instanceof Error ? error.message : String(error));
      return (await this.store.get(contextId))!;
    }
  }

  getRuntime(contextId: string): ChildContextRuntime | undefined { return this.runtimes.get(contextId); }
  get(contextId: string): Promise<PersistedChildContextV4 | undefined> { return this.store.get(contextId); }
  list(): Promise<PersistedChildContextV4[]> { return this.store.list(); }
  children(rootSessionId: string, parentContextId?: string): Promise<PersistedChildContextV4[]> {
    return this.store.listChildren(rootSessionId, parentContextId);
  }

  async resume(input: {
    contextId: string;
    modelRegistry: ModelRegistry;
    extensions?: readonly InlineExtension[];
    reconciliationSummary: string;
  }): Promise<PersistedChildContextV4> {
    const current = await this.store.get(input.contextId);
    if (!current) throw new Error(`Unknown child context: ${input.contextId}`);
    if (current.execution.phase !== "interrupted") {
      throw new Error(`Only interrupted child contexts may resume; current phase is ${current.execution.phase}.`);
    }
    if (this.runtimes.has(input.contextId)) throw new Error(`Child context ${input.contextId} already has an active SDK runtime.`);
    const cycleId = this.id();
    const startedAt = this.now();
    await this.store.update(input.contextId, (record) => ({
      ...record,
      execution: { phase: "starting", cycleId, startedAt },
      updatedAt: startedAt,
    }));
    try {
      const handle = await this.sessionFactory.create({
        contextId: current.contextId,
        cwd: current.cwd,
        stateRoot: this.stateRoot,
        agentDir: this.agentDir,
        agent: current.agent,
        modelRegistry: input.modelRegistry,
        systemPrompt: current.agent.systemPrompt,
        extensions: input.extensions,
        ...(current.execution.sessionFile ? { sessionFile: current.execution.sessionFile } : {}),
      });
      const running = await this.store.update(input.contextId, (record) => ({
        ...record,
        execution: { phase: "running", cycleId, startedAt, sessionId: handle.sessionId, sessionFile: handle.sessionFile },
        updatedAt: this.now(),
      }));
      const unsubscribe = handle.session.subscribe((event) => {
        if (event.type !== "message_end" || event.message.role !== "assistant" || !this.usageLedger) return;
        void this.usageLedger.recordAssistant({
          contextId: current.contextId,
          cycleId,
          role: current.agent.name,
          provider: current.agent.provider,
          model: current.agent.model,
          message: event.message,
        });
      });
      const completion = handle.waitForIdle();
      this.runtimes.set(input.contextId, { contextId: input.contextId, cycleId, handle, completion, unsubscribe });
      handle.send({
        customType: "pi-tai-continue-v1",
        content: bounded(input.reconciliationSummary, 8_000, "reconciliation summary"),
        details: { kind: "continue", reconciliationSummary: input.reconciliationSummary },
        delivery: "steer",
        triggerTurn: true,
      });
      return running;
    } catch (error) {
      await this.recordIncident(input.contextId, cycleId, error instanceof Error ? error.message : String(error));
      return (await this.store.get(input.contextId))!;
    }
  }

  async message(
    contextId: string,
    input: { customType: string; content: string; details: unknown; delivery?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
  ): Promise<void> {
    const runtime = this.requireRuntime(contextId);
    runtime.handle.send({
      customType: input.customType,
      content: bounded(input.content, 16_000, "child message"),
      details: input.details,
      delivery: input.delivery ?? "steer",
      triggerTurn: input.triggerTurn ?? true,
    });
  }

  async cancel(contextId: string): Promise<ChildCancellationResult> {
    const records = await this.store.list();
    const root = records.find((record) => record.contextId === contextId);
    if (!root) throw new Error(`Unknown child context: ${contextId}`);
    const rootWasTerminal = isTerminalExecution(root);
    const selectedIds = descendantIds(records, contextId);
    const depths = contextDepths(records);
    const selected = records
      .filter((record) => selectedIds.has(record.contextId))
      .sort((left, right) => (depths.get(right.contextId) ?? 0) - (depths.get(left.contextId) ?? 0));
    const hadCancellableContext = selected.some((record) =>
      !isTerminalExecution(record) && record.execution.phase !== "incident" && record.execution.phase !== "interrupted"
    );

    for (const record of selected) {
      if (isTerminalExecution(record) || record.execution.phase === "incident" || record.execution.phase === "interrupted") continue;
      if (record.execution.phase !== "cancelling") {
        const requestedAt = this.now();
        await this.store.update(record.contextId, (current) => {
          if (isTerminalExecution(current) || current.execution.phase === "cancelling") return current;
          if (current.execution.phase === "incident" || current.execution.phase === "interrupted") return current;
          return {
            ...current,
            execution: {
              phase: "cancelling",
              cycleId: current.execution.cycleId,
              requestedAt,
              reason: "Cancellation requested by parent.",
              ...(current.execution.phase === "running" || current.execution.phase === "awaiting_parent"
                ? { sessionId: current.execution.sessionId, sessionFile: current.execution.sessionFile }
                : {}),
            },
            updatedAt: requestedAt,
          };
        });
      }
    }

    const settlements: Promise<void>[] = [];
    const settlementById = new Map<string, Promise<void>>();
    for (const record of selected) {
      if (isTerminalExecution(record) || record.execution.phase === "incident" || record.execution.phase === "interrupted") continue;
      const runtime = this.runtimes.get(record.contextId);
      if (!runtime) continue;
      const descendantSettlements = [...settlementById.entries()]
        .filter(([candidateId]) => isContextDescendant(records, candidateId, record.contextId))
        .map(([, settlement]) => settlement);
      const settlement = this.beginCancellation(runtime, descendantSettlements);
      settlementById.set(record.contextId, settlement);
      settlements.push(settlement);
    }
    if (settlements.length > 0) await waitForSettlements(settlements, this.cancellationGraceMs);

    const contexts = (await Promise.all(selected.map((record) => this.store.get(record.contextId))))
      .filter((record): record is PersistedChildContextV4 => Boolean(record));
    const pendingContextIds = contexts
      .filter((record) => record.execution.phase === "cancelling")
      .map((record) => record.contextId);
    if (pendingContextIds.length > 0) return { disposition: "pending", contexts, pendingContextIds };
    return { disposition: rootWasTerminal && !hadCancellableContext ? "already_terminal" : "cancelled", contexts, pendingContextIds: [] };
  }

  releaseRuntime(contextId: string): void {
    const runtime = this.runtimes.get(contextId);
    if (!runtime) return;
    runtime.unsubscribe();
    runtime.handle.dispose();
    this.runtimes.delete(contextId);
  }

  async disposeRoot(rootSessionId: string): Promise<void> {
    const settlements: Promise<void>[] = [];
    for (const record of await this.store.list()) {
      if (record.rootSessionId !== rootSessionId) continue;
      const runtime = this.runtimes.get(record.contextId);
      if (!runtime) continue;
      if (["starting", "running", "awaiting_parent", "cancelling"].includes(record.execution.phase)) {
        const interruptedAt = this.now();
        await this.store.update(record.contextId, (current) => isTerminalExecution(current)
          ? current
          : {
              ...current,
              execution: {
                phase: "interrupted",
                cycleId: runtime.cycleId,
                reason: "Root coordinator disposed before runtime quiescence was proved.",
                interruptedAt,
                sessionFile: runtime.handle.sessionFile,
              },
              updatedAt: interruptedAt,
            });
      }
      const settlement = runtime.handle.abort()
        .then(() => runtime.handle.waitForIdle())
        .then(() => this.releaseRuntime(record.contextId))
        .catch(() => undefined);
      settlements.push(settlement);
    }
    if (settlements.length > 0) await waitForSettlements(settlements, this.cancellationGraceMs);
  }

  private beginCancellation(runtime: ChildContextRuntime, descendantSettlements: readonly Promise<void>[] = []): Promise<void> {
    const existing = this.cancellations.get(runtime.contextId);
    if (existing) return existing;
    let settlement!: Promise<void>;
    settlement = runtime.handle.abort()
      .then(() => runtime.handle.waitForIdle())
      .then(() => Promise.all(descendantSettlements))
      .then(() => this.finalizeCancellation(runtime))
      .catch(() => new Promise<void>(() => undefined))
      .finally(() => {
        if (this.cancellations.get(runtime.contextId) === settlement) this.cancellations.delete(runtime.contextId);
      });
    this.cancellations.set(runtime.contextId, settlement);
    return settlement;
  }

  private async finalizeCancellation(runtime: ChildContextRuntime): Promise<void> {
    const current = await this.store.get(runtime.contextId);
    if (!current || current.execution.phase !== "cancelling" || current.execution.cycleId !== runtime.cycleId) {
      if (current && isTerminalExecution(current)) this.releaseRuntime(runtime.contextId);
      return;
    }
    const eventId = this.id();
    const timestamp = this.now();
    const event: PersistedChildEventV4 = {
      eventId,
      contextId: runtime.contextId,
      cycleId: runtime.cycleId,
      kind: "terminal",
      payload: { outcome: "cancelled", summary: "Child execution cycle was explicitly cancelled." },
      delivery: { phase: "persisted", createdAt: timestamp },
    };
    const updated = await this.store.update(runtime.contextId, (latest) => latest.execution.phase !== "cancelling" || latest.execution.cycleId !== runtime.cycleId
      ? latest
      : {
          ...latest,
          execution: { phase: "cancelled", cycleId: runtime.cycleId, terminalEventId: eventId, finishedAt: timestamp },
          events: [...latest.events, event],
          updatedAt: timestamp,
        });
    if (updated.execution.phase === "cancelled" && this.onCancelled) {
      await Promise.resolve(this.onCancelled(updated)).catch(() => undefined);
    }
    this.releaseRuntime(runtime.contextId);
  }

  private requireRuntime(contextId: string): ChildContextRuntime {
    const runtime = this.runtimes.get(contextId);
    if (!runtime) throw new Error(`Child context ${contextId} has no active SDK runtime.`);
    return runtime;
  }

  private async recordIncident(contextId: string, cycleId: string, reason: string): Promise<void> {
    const timestamp = this.now();
    const eventId = this.id();
    await this.store.update(contextId, (current) => ({
      ...current,
      execution: { phase: "incident", cycleId, reason: bounded(reason, 8_000, "incident"), stoppedAt: timestamp },
      events: [...current.events, {
        eventId,
        contextId,
        cycleId,
        kind: "incident",
        payload: { reason: bounded(reason, 8_000, "incident") },
        delivery: { phase: "persisted", createdAt: timestamp },
      }],
      updatedAt: timestamp,
    }));
  }
}

function isTerminalExecution(context: PersistedChildContextV4): boolean {
  return ["completed", "blocked", "failed", "cancelled"].includes(context.execution.phase);
}

function descendantIds(records: readonly PersistedChildContextV4[], rootId: string): Set<string> {
  const selected = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (record.parentContextId && selected.has(record.parentContextId) && !selected.has(record.contextId)) {
        selected.add(record.contextId);
        changed = true;
      }
    }
  }
  return selected;
}

function isContextDescendant(records: readonly PersistedChildContextV4[], candidateId: string, ancestorId: string): boolean {
  const byId = new Map(records.map((record) => [record.contextId, record]));
  let parent = byId.get(candidateId)?.parentContextId;
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) {
    if (parent === ancestorId) return true;
    seen.add(parent);
    parent = byId.get(parent)?.parentContextId;
  }
  return false;
}

function contextDepths(records: readonly PersistedChildContextV4[]): Map<string, number> {
  const byId = new Map(records.map((record) => [record.contextId, record]));
  const depths = new Map<string, number>();
  for (const record of records) {
    let depth = 0;
    let parent = record.parentContextId;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const ancestor = byId.get(parent);
      if (!ancestor) break;
      depth += 1;
      parent = ancestor.parentContextId;
    }
    depths.set(record.contextId, depth);
  }
  return depths;
}

async function waitForSettlements(settlements: readonly Promise<void>[], timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(settlements).then(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function bounded(value: string, limit: number, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} must not be empty.`);
  if (Buffer.byteLength(text, "utf8") > limit) throw new Error(`${label} exceeds ${limit} bytes.`);
  return text;
}
