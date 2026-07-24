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
}

export class ChildContextCoordinator {
  private readonly store: ChildContextStore;
  private readonly sessionFactory: PrivateChildSessionFactoryPort;
  private readonly stateRoot: string;
  private readonly agentDir: string;
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly usageLedger?: ChildUsageLedger;
  private readonly runtimes = new Map<string, ChildContextRuntime>();

  constructor(options: ChildContextCoordinatorOptions) {
    this.store = options.store;
    this.sessionFactory = options.sessionFactory;
    this.stateRoot = options.stateRoot;
    this.agentDir = options.agentDir;
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? randomUUID;
    this.usageLedger = options.usageLedger;
  }

  async spawn(request: SpawnContextRequest): Promise<PersistedChildContextV4> {
    if (!request.caller.allowedChildren.includes(request.agent.name)) {
      throw new Error(`Agent "${request.caller.name}" cannot create "${request.agent.name}".`);
    }
    const contextId = this.id();
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
      ...(request.workspace ? { workspace: request.workspace } : {}),
      execution: { phase: "created", cycleId },
      events: [],
      usage: [],
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
      const completion = handle.session.prompt(renderTaskPacket(request.task), { source: "rpc" })
        .then(() => undefined)
        .catch(async (error) => {
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

  async cancel(contextId: string): Promise<PersistedChildContextV4> {
    const runtime = this.requireRuntime(contextId);
    await runtime.handle.abort();
    await runtime.completion.catch(() => undefined);
    const eventId = this.id();
    const timestamp = this.now();
    const event: PersistedChildEventV4 = {
      eventId,
      contextId,
      cycleId: runtime.cycleId,
      kind: "terminal",
      payload: { outcome: "cancelled", summary: "Child execution cycle was explicitly cancelled." },
      delivery: { phase: "persisted", createdAt: timestamp },
    };
    const updated = await this.store.update(contextId, (current) => ({
      ...current,
      execution: { phase: "cancelled", cycleId: runtime.cycleId, terminalEventId: eventId, finishedAt: timestamp },
      events: [...current.events, event],
      updatedAt: timestamp,
    }));
    runtime.unsubscribe();
    runtime.handle.dispose();
    this.runtimes.delete(contextId);
    return updated;
  }

  releaseRuntime(contextId: string): void {
    const runtime = this.runtimes.get(contextId);
    if (!runtime) return;
    runtime.unsubscribe();
    runtime.handle.dispose();
    this.runtimes.delete(contextId);
  }

  async disposeRoot(rootSessionId: string): Promise<void> {
    for (const record of await this.store.list()) {
      if (record.rootSessionId !== rootSessionId) continue;
      const runtime = this.runtimes.get(record.contextId);
      if (!runtime) continue;
      await runtime.handle.abort().catch(() => undefined);
      runtime.unsubscribe();
      runtime.handle.dispose();
      this.runtimes.delete(record.contextId);
      if (["starting", "running", "awaiting_parent"].includes(record.execution.phase)) {
        await this.store.update(record.contextId, (current) => ({
          ...current,
          execution: {
            phase: "interrupted",
            cycleId: runtime.cycleId,
            reason: "Root coordinator disposed.",
            interruptedAt: this.now(),
            sessionFile: runtime.handle.sessionFile,
          },
          updatedAt: this.now(),
        }));
      }
    }
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

function bounded(value: string, limit: number, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} must not be empty.`);
  if (Buffer.byteLength(text, "utf8") > limit) throw new Error(`${label} exceeds ${limit} bytes.`);
  return text;
}
