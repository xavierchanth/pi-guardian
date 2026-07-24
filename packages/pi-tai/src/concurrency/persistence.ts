import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AgentDefinitionSnapshot, DelegationRecord } from "../subagents/store.ts";
import type { ResolvedTaskPacket } from "../subagents/task.ts";
import type { WorkspaceAttachment } from "../workspaces/domain.ts";

export type PersistedExecutionCycleV4 =
  | { phase: "created"; cycleId: string }
  | { phase: "starting"; cycleId: string; startedAt: string }
  | { phase: "running"; cycleId: string; startedAt: string; sessionId: string; sessionFile: string }
  | { phase: "awaiting_parent"; cycleId: string; questionEventId: string; sessionId: string; sessionFile: string }
  | { phase: "interrupted"; cycleId: string; reason: string; interruptedAt: string; sessionFile?: string }
  | { phase: "completed" | "blocked" | "failed" | "cancelled"; cycleId: string; terminalEventId: string; finishedAt: string }
  | { phase: "incident"; cycleId?: string; reason: string; stoppedAt: string };

export type PersistedChildEventV4 = {
  eventId: string;
  contextId: string;
  cycleId?: string;
  kind: "question" | "status" | "terminal" | "incident";
  payload: unknown;
  delivery:
    | { phase: "persisted"; createdAt: string }
    | { phase: "delivered"; createdAt: string; deliveredAt: string }
    | { phase: "acknowledged"; createdAt: string; deliveredAt: string; acknowledgedAt: string };
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
  workspace?: WorkspaceAttachment;
  execution: PersistedExecutionCycleV4;
  events: PersistedChildEventV4[];
  usage: PersistedUsageEntryV4[];
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
  if (!record(input.task) || !record(input.agent) || !record(input.execution)) throw new Error("Child context task, agent, and execution are required objects.");
  if (!Array.isArray(input.events) || !Array.isArray(input.usage)) throw new Error("Child context events and usage must be arrays.");
  validateExecution(input.execution);
  for (const event of input.events) validateEvent(event, input.contextId as string);
  for (const entry of input.usage) validateUsage(entry, input.contextId as string);
  return input as unknown as PersistedChildContextV4;
}

function validateExecution(value: Record<string, unknown>): void {
  const phase = nonempty(value.phase, "execution.phase");
  const phases = ["created", "starting", "running", "awaiting_parent", "interrupted", "completed", "blocked", "failed", "cancelled", "incident"];
  if (!phases.includes(phase)) throw new Error(`Invalid execution phase: ${phase}`);
  if (phase !== "incident" || value.cycleId !== undefined) validateId(nonempty(value.cycleId, "execution.cycleId"));
  if ((phase === "running" || phase === "awaiting_parent") && (!value.sessionId || !value.sessionFile)) {
    throw new Error(`${phase} execution requires session identity.`);
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
