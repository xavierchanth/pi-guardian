import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AgentDefinitionSnapshot, DelegationRecord } from "../subagents/store.ts";
import type { ResolvedTaskPacket } from "../subagents/task.ts";
import type { WorkspaceAttachment } from "../workspaces/domain.ts";
import { HostConcurrencyRepository } from "./host-repository.ts";
import type { ConcurrencyProjectionV1 } from "./productization.ts";

export type PersistedExecutionCycleV4 =
  | { phase: "created"; cycleId: string }
  | { phase: "starting"; cycleId: string; startedAt: string }
  | { phase: "running"; cycleId: string; startedAt: string; sessionId: string; sessionFile: string }
  | { phase: "awaiting_parent"; cycleId: string; questionEventId: string; startedAt: string; sessionId: string; sessionFile: string }
  | { phase: "cancelling"; cycleId: string; requestedAt: string; reason: string; sessionId?: string; sessionFile?: string }
  | { phase: "interrupted"; cycleId: string; reason: string; interruptedAt: string; sessionFile?: string }
  | { phase: "completed" | "blocked" | "failed" | "cancelled"; cycleId: string; terminalEventId: string; finishedAt: string }
  | { phase: "incident"; cycleId?: string; reason: string; stoppedAt: string };

export type PersistedChildEventV4 = {
  eventId: string;
  contextId: string;
  cycleId?: string;
  kind: "question" | "status" | "terminal" | "incident" | "human_execution_required";
  payload: unknown;
  delivery:
    | { phase: "persisted"; createdAt: string }
    | { phase: "delivered"; createdAt: string; deliveredAt: string }
    | { phase: "acknowledged"; createdAt: string; deliveredAt: string; acknowledgedAt: string };
};

export type PersistedTelemetryGapV4 = {
  version: 1;
  gapId: string;
  contextId: string;
  cycleId: string;
  reason: "missing_message_usage" | "missing_message_identity";
  observedAt: string;
};

export type PersistedUsageEntryV4 = {
  usageEventId: string;
  contextId: string;
  cycleId: string;
  provider: string;
  model: string;
  role: string;
  messageId: string;
  quality: "message" | "settled_delta";
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  recordedAt: string;
};

export interface PersistedChildContextV4 {
  version: 4;
  contextId: string;
  rootSessionId: string;
  parentContextId?: string;
  cwd: string;
  task: ResolvedTaskPacket;
  agent: AgentDefinitionSnapshot;
  /** Authoritative workspace reference for tracked isolated execution. */
  taskId?: string;
  workspaceId?: string;
  /** Compatibility projection for pre-M3 records only; new launches must not populate this with workspaceId. */
  workspace?: WorkspaceAttachment;
  execution: PersistedExecutionCycleV4;
  events: PersistedChildEventV4[];
  usage: PersistedUsageEntryV4[];
  telemetryGaps: PersistedTelemetryGapV4[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  legacy?: { delegationId: string; version: 3 };
}

export type LoadedContextRecord =
  | { kind: "v4"; record: PersistedChildContextV4 }
  | { kind: "legacy_v3"; record: DelegationRecord }
  | { kind: "quarantined"; path: string; reason: string };

export interface ChildContextStore {
  create(record: PersistedChildContextV4): Promise<void>;
  get(id: string): Promise<PersistedChildContextV4 | undefined>;
  update(id: string, reducer: (record: PersistedChildContextV4) => PersistedChildContextV4): Promise<PersistedChildContextV4>;
  list(): Promise<PersistedChildContextV4[]>;
  listChildren(rootSessionId: string, parentContextId?: string): Promise<PersistedChildContextV4[]>;
  remove(id: string): Promise<void>;
}

export class FileChildContextStore implements ChildContextStore {
  readonly root: string;

  constructor(root: string) { this.root = resolve(root); }

  async create(record: PersistedChildContextV4): Promise<void> {
    validateContextRecord(record);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeExclusive(this.path(record.contextId), record);
  }

  async get(id: string): Promise<PersistedChildContextV4 | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path(id), "utf8"));
      return validateContextRecord(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async update(id: string, reducer: (record: PersistedChildContextV4) => PersistedChildContextV4): Promise<PersistedChildContextV4> {
    const current = await this.get(id);
    if (!current) throw new Error(`Unknown child context: ${id}`);
    const next = validateContextRecord(reducer(structuredClone(current)));
    if (next.contextId !== id) throw new Error("Child context update cannot change identity.");
    const temporary = `${this.path(id)}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, this.path(id));
    return next;
  }

  async list(): Promise<PersistedChildContextV4[]> {
    try {
      const names = (await readdir(this.root)).filter((name) => name.endsWith(".json")).sort();
      const records: PersistedChildContextV4[] = [];
      for (const name of names) {
        const record = await this.get(name.slice(0, -5));
        if (record) records.push(record);
      }
      return records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async listChildren(rootSessionId: string, parentContextId?: string): Promise<PersistedChildContextV4[]> {
    return (await this.list()).filter((record) =>
      record.rootSessionId === rootSessionId && record.parentContextId === parentContextId,
    );
  }

  async remove(id: string): Promise<void> { await rm(this.path(id), { force: true }); }

  private path(id: string): string {
    validateId(id);
    return join(this.root, `${id}.json`);
  }
}

interface HostConcurrencyStateV1 { version: 1; contexts: PersistedChildContextV4[]; readonly [segment: string]: unknown }

export class HostChildContextStore implements ChildContextStore {
  private readonly repository: HostConcurrencyRepository;
  private readonly rootSessionId: string;
  private readonly runtimeGeneration: number;
  private readonly now: () => string;
  constructor(options: { repository: HostConcurrencyRepository; rootSessionId: string; runtimeGeneration: number; now?: () => string }) {
    this.repository = options.repository; this.rootSessionId = options.rootSessionId; this.runtimeGeneration = options.runtimeGeneration; this.now = options.now ?? (() => new Date().toISOString());
  }
  async create(record: PersistedChildContextV4): Promise<void> {
    validateContextRecord(record); if (record.rootSessionId !== this.rootSessionId) throw new Error("Child context belongs to another Host session.");
    await this.mutate("child.created", { contextId: record.contextId }, (contexts) => {
      if (contexts.some((context) => context.contextId === record.contextId)) throw new Error(`Child context already exists: ${record.contextId}`);
      return [...contexts, record];
    });
  }
  async get(id: string): Promise<PersistedChildContextV4 | undefined> { return (await this.load()).contexts.find((context) => context.contextId === id); }
  async update(id: string, reducer: (record: PersistedChildContextV4) => PersistedChildContextV4): Promise<PersistedChildContextV4> {
    let output: PersistedChildContextV4 | undefined;
    await this.mutate("child.replaced", { contextId: id }, (contexts) => contexts.map((context) => {
      if (context.contextId !== id) return context;
      const next = validateContextRecord(reducer(structuredClone(context)));
      if (next.contextId !== id || next.rootSessionId !== this.rootSessionId) throw new Error("Child context update changed durable identity.");
      output = next; return next;
    }), id);
    if (!output) throw new Error(`Unknown child context: ${id}`); return output;
  }
  async list(): Promise<PersistedChildContextV4[]> { return (await this.load()).contexts; }
  async listChildren(rootSessionId: string, parentContextId?: string): Promise<PersistedChildContextV4[]> {
    if (rootSessionId !== this.rootSessionId) return [];
    return (await this.list()).filter((record) => record.parentContextId === parentContextId);
  }
  async remove(id: string): Promise<void> { await this.mutate("child.removed", { contextId: id }, (contexts) => contexts.filter((context) => context.contextId !== id)); }

  private async mutate(type: string, payload: unknown, reducer: (contexts: PersistedChildContextV4[]) => PersistedChildContextV4[], requiredId?: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const aggregate = await this.repository.load();
      const state = parseHostState(aggregate?.state, this.rootSessionId);
      if (requiredId && !state.contexts.some((context) => context.contextId === requiredId)) throw new Error(`Unknown child context: ${requiredId}`);
      const contexts = reducer(state.contexts.map((context) => structuredClone(context)));
      if (contexts.length > 256) throw new Error("Host concurrency state exceeds 256 child contexts.");
      const revision = aggregate?.revision ?? 0;
      try {
        await this.repository.transact({
          version: 1, transactionId: `context-transaction-${randomUUID()}`, rootSessionId: this.rootSessionId, runtimeGeneration: this.runtimeGeneration, expectedRevision: revision,
          events: [{ eventId: `context-event-${randomUUID()}`, type, payload }], state: { ...state, version: 1, contexts }, projection: projectHostState(this.rootSessionId, revision + 1, contexts, this.now()),
        });
        return;
      } catch (error) {
        if (attempt === 1 || !/revision/i.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
  }
  private async load(): Promise<HostConcurrencyStateV1> { const aggregate = await this.repository.load(); return parseHostState(aggregate?.state, this.rootSessionId); }
}

function parseHostState(value: unknown, rootSessionId: string): HostConcurrencyStateV1 {
  if (value === undefined || value === null) return { version: 1, contexts: [] };
  if (!record(value) || value.version !== 1 || !Array.isArray(value.contexts)) throw new Error("Host concurrency state is invalid.");
  const contexts = value.contexts.map(validateContextRecord);
  if (contexts.some((context) => context.rootSessionId !== rootSessionId)) throw new Error("Host concurrency state crosses root-session authority.");
  return { ...value, version: 1, contexts } as HostConcurrencyStateV1;
}
function projectHostState(rootSessionId: string, revision: number, contexts: PersistedChildContextV4[], generatedAt: string): ConcurrencyProjectionV1 {
  const ordered = [...contexts].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)); const selected = ordered.slice(0, 256);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of contexts.flatMap((context) => context.usage)) { usage.input += entry.input; usage.output += entry.output; usage.cacheRead += entry.cacheRead; usage.cacheWrite += entry.cacheWrite; usage.cost += entry.cost; }
  return {
    version: 1, rootSessionId, revision, generatedAt,
    children: selected.map((context) => ({ contextId: context.contextId, ...(context.parentContextId ? { parentContextId: context.parentContextId } : {}), ...(context.taskId ? { taskId: context.taskId } : {}), role: context.agent.name, objective: context.task.objective, phase: context.execution.phase, ...(context.execution.cycleId ? { executionCycleId: context.execution.cycleId } : {}), ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}), ...("questionEventId" in context.execution ? { questionId: context.execution.questionEventId } : {}), ...("terminalEventId" in context.execution ? { terminalEventId: context.execution.terminalEventId } : {}), updatedAt: context.updatedAt })),
    inactiveChildCount: Math.max(0, contexts.length - selected.length), tasks: [], inactiveTaskCount: 0, workspaces: [], activeClaimCount: 0,
    unansweredQuestionCount: contexts.flatMap((context) => context.events).filter((event) => event.kind === "question" && !(event.payload as any)?.answeredAt).length,
    usage, telemetryGapCount: contexts.reduce((total, context) => total + context.telemetryGaps.length, 0), truncated: contexts.length > selected.length,
  };
}

export interface PrivateContextPaths {
  root: string;
  sessions: string;
  artifacts: string;
}

export function privateContextPaths(stateRoot: string, contextId: string): PrivateContextPaths {
  validateId(contextId);
  const contextsRoot = resolve(stateRoot, "contexts");
  const root = resolve(contextsRoot, contextId);
  if (dirname(root) !== contextsRoot) throw new Error("Private context path escaped its managed root.");
  return { root, sessions: join(root, "sessions"), artifacts: join(root, "artifacts") };
}

export function validateContextRecord(input: unknown): PersistedChildContextV4 {
  if (!record(input) || input.version !== 4) throw new Error("Child context record must use version 4.");
  for (const field of ["contextId", "rootSessionId", "cwd", "createdAt", "updatedAt"] as const) nonempty(input[field], field);
  validateId(input.contextId as string);
  if (input.parentContextId !== undefined) validateId(nonempty(input.parentContextId, "parentContextId"));
  if (input.taskId !== undefined) validateId(nonempty(input.taskId, "taskId"));
  if (input.workspaceId !== undefined) validateId(nonempty(input.workspaceId, "workspaceId"));
  if (input.workspaceId !== undefined && input.workspace !== undefined) throw new Error("Child context cannot contain both authoritative workspaceId and legacy workspace attachment.");
  if (!record(input.task) || !record(input.agent) || !record(input.execution)) throw new Error("Child context task, agent, and execution are required objects.");
  if (!Array.isArray(input.events) || !Array.isArray(input.usage) || !Array.isArray(input.telemetryGaps)) throw new Error("Child context events, usage, and telemetry gaps must be arrays.");
  validateExecution(input.execution);
  for (const event of input.events) validateEvent(event, input.contextId as string);
  for (const entry of input.usage) validateUsage(entry, input.contextId as string);
  for (const gap of input.telemetryGaps) validateTelemetryGap(gap, input.contextId as string);
  return input as unknown as PersistedChildContextV4;
}

function validateExecution(value: Record<string, unknown>): void {
  const phase = nonempty(value.phase, "execution.phase");
  const phases = ["created", "starting", "running", "awaiting_parent", "cancelling", "interrupted", "completed", "blocked", "failed", "cancelled", "incident"];
  if (!phases.includes(phase)) throw new Error(`Invalid execution phase: ${phase}`);
  if (phase !== "incident" || value.cycleId !== undefined) validateId(nonempty(value.cycleId, "execution.cycleId"));
  if ((phase === "running" || phase === "awaiting_parent") && (!value.sessionId || !value.sessionFile)) {
    throw new Error(`${phase} execution requires session identity.`);
  }
  if (phase === "cancelling") {
    nonempty(value.requestedAt, "execution.requestedAt");
    nonempty(value.reason, "execution.reason");
    if (Boolean(value.sessionId) !== Boolean(value.sessionFile)) throw new Error("cancelling execution requires both session identity fields or neither.");
  }
  if (["completed", "blocked", "failed", "cancelled"].includes(phase) && !value.terminalEventId) {
    throw new Error(`${phase} execution requires terminalEventId.`);
  }
}

function validateEvent(value: unknown, contextId: string): void {
  if (!record(value)) throw new Error("Child event must be an object.");
  validateId(nonempty(value.eventId, "event.eventId"));
  if (value.contextId !== contextId) throw new Error("Child event context identity mismatch.");
  if (!record(value.delivery) || !["persisted", "delivered", "acknowledged"].includes(String(value.delivery.phase))) {
    throw new Error("Child event delivery state is invalid.");
  }
}

function validateTelemetryGap(value: unknown, contextId: string): void {
  if (!record(value) || value.version !== 1) throw new Error("Telemetry gap must use version 1.");
  validateId(nonempty(value.gapId, "telemetryGap.gapId")); validateId(nonempty(value.cycleId, "telemetryGap.cycleId"));
  if (value.contextId !== contextId || !["missing_message_usage", "missing_message_identity"].includes(String(value.reason))) throw new Error("Telemetry gap identity or reason is invalid.");
  nonempty(value.observedAt, "telemetryGap.observedAt");
}

function validateUsage(value: unknown, contextId: string): void {
  if (!record(value)) throw new Error("Usage entry must be an object.");
  validateId(nonempty(value.usageEventId, "usage.usageEventId"));
  if (value.contextId !== contextId) throw new Error("Usage context identity mismatch.");
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || (value[key] as number) < 0) throw new Error(`Usage ${key} must be nonnegative.`);
  }
}

function validateId(value: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error(`Invalid managed context ID: ${value}`);
}
function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string.`);
  return value;
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
async function writeExclusive(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}
