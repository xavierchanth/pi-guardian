import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceAttachment, WorkspaceTip } from "../workspaces/domain.ts";
import type {
  AgentDefinition,
  AgentDefinitionSource,
  AgentEffort,
  UncertaintyHandling,
} from "./agents.ts";
import type { ResolvedTaskPacket } from "./task.ts";

export const TERMINAL_CHILD_PHASES = ["completed", "blocked", "failed", "cancelled", "abandoned"] as const;
export type TerminalChildPhase = (typeof TERMINAL_CHILD_PHASES)[number];
export type ChildMessageDelivery = "steer" | "followUp";

export interface AgentDefinitionSnapshot {
  name: string;
  description: string;
  root: boolean;
  provider: string;
  model: string;
  effort: AgentEffort;
  tools: string[];
  allowedChildren: string[];
  uncertaintyHandling: UncertaintyHandling;
  systemPrompt: string;
  source: AgentDefinitionSource | "legacy";
  filePath: string;
  contentHash: string;
}

export interface ChildReport {
  outcome: "completed" | "blocked" | "failed" | "cancelled";
  summary: string;
  validation?: string[];
  changedFiles?: string[];
  concerns?: string[];
  reportedAt: string;
}

export interface ParentQuestion {
  id: string;
  question: string;
  options?: string[];
  recommendation?: string;
  consequences?: string[];
  askedAt: string;
}

export interface AnsweredParentQuestion extends ParentQuestion {
  response: string;
  answeredAt: string;
}

export type DelegationExecution =
  | { phase: "created" }
  | { phase: "running"; activity?: string }
  | { phase: "awaiting_parent"; question: ParentQuestion }
  | { phase: "completed" | "blocked" | "failed" | "cancelled"; report: ChildReport }
  | { phase: "abandoned"; reason?: string };

export interface ParentMessage {
  message: string;
  delivery: ChildMessageDelivery;
  sentAt: string;
  questionId?: string;
}

export type DelegatedWorkspaceState =
  | { phase: "active"; attachment: WorkspaceAttachment }
  | {
      phase: "attention_required";
      attachment: WorkspaceAttachment;
      operation: "integration";
      tip: WorkspaceTip;
      reason: string;
      stoppedAt: string;
    }
  | {
      phase: "attention_required";
      attachment: WorkspaceAttachment;
      operation: "cleanup";
      tip: WorkspaceTip;
      integratedAt: string;
      reason: string;
      stoppedAt: string;
    }
  | {
      phase: "integrated";
      attachment: WorkspaceAttachment;
      tip: WorkspaceTip;
      integratedAt: string;
    }
  | {
      phase: "cleaned";
      attachment: WorkspaceAttachment;
      tip: WorkspaceTip;
      integratedAt: string;
      cleanedAt: string;
    };

export interface DelegationRecord {
  version: 3;
  id: string;
  parentSessionId: string;
  parentDelegationId?: string;
  cwd: string;
  task: ResolvedTaskPacket;
  agent: AgentDefinitionSnapshot;
  execution: DelegationExecution;
  childSessionId?: string;
  childSessionFile?: string;
  childPid?: number;
  childLogPath?: string;
  childControlPath?: string;
  childPromptPath?: string;
  parentMessages?: ParentMessage[];
  answeredQuestions?: AnsweredParentQuestion[];
  parentCollectedAt?: string;
  workspace?: DelegatedWorkspaceState;
  legacyWorkspace?: WorkspaceAttachment;
  createdAt: string;
  updatedAt: string;
}

export interface DelegationStore {
  readonly root?: string;
  create(record: DelegationRecord): Promise<void>;
  get(id: string): Promise<DelegationRecord | undefined>;
  update(id: string, update: (record: DelegationRecord) => DelegationRecord): Promise<DelegationRecord>;
  list(): Promise<DelegationRecord[]>;
  listChildren(parentSessionId: string): Promise<DelegationRecord[]>;
}

export function snapshotAgentDefinition(definition: AgentDefinition): AgentDefinitionSnapshot {
  return {
    name: definition.name,
    description: definition.description,
    root: definition.root,
    provider: definition.provider,
    model: definition.model,
    effort: definition.effort,
    tools: [...definition.tools],
    allowedChildren: [...definition.allowedChildren],
    uncertaintyHandling: definition.uncertaintyHandling,
    systemPrompt: definition.systemPrompt,
    source: definition.source,
    filePath: definition.filePath,
    contentHash: definition.contentHash,
  };
}

export class FileDelegationStore implements DelegationStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async create(record: DelegationRecord): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      await writeFile(this.path(record.id), `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Delegation already exists: ${record.id}`);
      }
      throw error;
    }
  }

  async get(id: string): Promise<DelegationRecord | undefined> {
    try {
      return parseRecord(JSON.parse(await readFile(this.path(id), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async update(
    id: string,
    update: (record: DelegationRecord) => DelegationRecord,
  ): Promise<DelegationRecord> {
    return this.withRecordLock(id, async () => {
      const current = await this.get(id);
      if (!current) throw new Error(`Unknown delegation: ${id}`);
      const next = {
        ...update(current),
        id: current.id,
        version: 3 as const,
        updatedAt: new Date().toISOString(),
      };
      validateRecord(next);
      const temporary = join(this.root, `.${id}.${process.pid}.${randomUUID()}.tmp`);
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, this.path(id));
      return next;
    });
  }

  async list(): Promise<DelegationRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records = await Promise.all(entries
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .map((name) => this.get(name.slice(0, -5))));
    return records.filter((record): record is DelegationRecord => Boolean(record));
  }

  async listChildren(parentSessionId: string): Promise<DelegationRecord[]> {
    return (await this.list()).filter((record) => record.parentSessionId === parentSessionId);
  }

  async remove(id: string): Promise<void> {
    await rm(this.path(id), { force: true });
  }

  private path(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid delegation id: ${id}`);
    return join(this.root, `${id}.json`);
  }

  private async withRecordLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lock = join(this.root, `.${id}.lock`);
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const info = await stat(lock);
          if (Date.now() - info.mtimeMs > 30_000) {
            await rm(lock, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`Timed out locking delegation: ${id}`);
        await delay(20);
      }
    }
    try {
      return await action();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
}

export interface WaitForChildrenOptions {
  signal?: AbortSignal;
  pollIntervalMs?: number;
  initialGraceMs?: number;
  childIds?: readonly string[];
  until?: "next" | "all";
  onProgress?: (records: readonly DelegationRecord[]) => void;
}

export function isResolvedDelegation(record: DelegationRecord): boolean {
  return TERMINAL_CHILD_PHASES.includes(record.execution.phase as TerminalChildPhase);
}

export function childReport(record: DelegationRecord): ChildReport | undefined {
  return "report" in record.execution ? record.execution.report : undefined;
}

export async function waitForChildren(
  store: DelegationStore,
  parentSessionId: string,
  options: WaitForChildrenOptions = {},
): Promise<DelegationRecord[]> {
  const interval = options.pollIntervalMs ?? 250;
  const graceDeadline = Date.now() + (options.initialGraceMs ?? 1_500);
  let available: DelegationRecord[] = [];
  do {
    if (options.signal?.aborted) throw new Error("Waiting for children was cancelled.");
    available = (await store.listChildren(parentSessionId)).filter((record) =>
      !options.childIds || options.childIds.includes(record.id),
    );
    if (available.length > 0 || Date.now() >= graceDeadline) break;
    await delay(Math.min(interval, graceDeadline - Date.now()), options.signal);
  } while (true);
  const snapshot = available.map((record) => record.id);
  if (snapshot.length === 0) return [];
  const until = options.until ?? "next";
  while (true) {
    if (options.signal?.aborted) throw new Error("Waiting for children was cancelled.");
    const records = (await Promise.all(snapshot.map((id) => store.get(id))))
      .filter((record): record is DelegationRecord => Boolean(record));
    options.onProgress?.(records);
    const attention = records.filter((record) => record.execution.phase === "awaiting_parent");
    if (attention.length > 0) return attention;
    const uncollected = records.filter((record) => isResolvedDelegation(record) && !record.parentCollectedAt);
    if (until === "next" && uncollected.length > 0) return collect(store, [uncollected[0]]);
    if (until === "next" && records.length === snapshot.length && records.every(isResolvedDelegation)) return [];
    if (until === "all" && records.length === snapshot.length && records.every(isResolvedDelegation)) {
      return collect(store, records.filter((record) => !record.parentCollectedAt));
    }
    await delay(interval, options.signal);
  }
}

async function collect(
  store: DelegationStore,
  records: readonly DelegationRecord[],
): Promise<DelegationRecord[]> {
  const collectedAt = new Date().toISOString();
  return Promise.all(records.map((record) => store.update(record.id, (current) => ({
    ...current,
    parentCollectedAt: current.parentCollectedAt ?? collectedAt,
  }))));
}

function parseRecord(value: unknown): DelegationRecord {
  if (!isRecord(value)) throw new Error("Invalid delegation record.");
  if (value.version === 3) {
    const record = value as unknown as DelegationRecord;
    validateRecord(record);
    return record;
  }
  if (value.version === 1 || value.version === 2) return migrateLegacyRecord(value);
  throw new Error("Invalid delegation record version.");
}

function migrateLegacyRecord(record: Record<string, unknown>): DelegationRecord {
  const workspace = legacyWorkspace(record);
  const oldState = typeof record.state === "string" ? record.state : "failed";
  const oldReport = isRecord(record.report) ? record.report : undefined;
  const report: ChildReport = {
    outcome: legacyOutcome(oldState),
    summary: typeof oldReport?.summary === "string"
      ? oldReport.summary
      : `Migrated legacy delegation in state ${oldState}.`,
    ...(Array.isArray(oldReport?.validation) ? { validation: oldReport.validation as string[] } : {}),
    ...(Array.isArray(oldReport?.changedFiles) ? { changedFiles: oldReport.changedFiles as string[] } : {}),
    ...(Array.isArray(oldReport?.concerns) ? { concerns: oldReport.concerns as string[] } : {}),
    reportedAt: typeof oldReport?.reportedAt === "string"
      ? oldReport.reportedAt
      : new Date(0).toISOString(),
  };
  const id = requiredLegacyString(record.id, "id");
  const objective = typeof record.task === "string" && record.task.trim()
    ? record.task.trim()
    : "Recover legacy delegated work.";
  const modelPreference = typeof record.modelPreferenceId === "string"
    ? record.modelPreferenceId
    : "worker";
  const execution: DelegationExecution = oldState === "created"
    ? { phase: "created" }
    : oldState === "running"
      ? { phase: "running" }
      : oldState === "abandoned"
        ? { phase: "abandoned", reason: report.summary }
        : { phase: report.outcome, report };
  const migrated: DelegationRecord = {
    version: 3,
    id,
    parentSessionId: requiredLegacyString(record.parentSessionId, "parentSessionId"),
    cwd: workspace.path,
    task: { objective, uncertaintyHandling: "block" },
    agent: {
      name: modelPreference,
      description: "Migrated legacy subagent model preference",
      root: false,
      provider: "legacy",
      model: modelPreference,
      effort: "off",
      tools: [],
      allowedChildren: [],
      uncertaintyHandling: "block",
      systemPrompt: "",
      source: "legacy",
      filePath: "",
      contentHash: "legacy",
    },
    execution,
    ...(typeof record.childSessionId === "string" ? { childSessionId: record.childSessionId } : {}),
    ...(typeof record.childSessionFile === "string" ? { childSessionFile: record.childSessionFile } : {}),
    ...(typeof record.childPid === "number" ? { childPid: record.childPid } : {}),
    ...(typeof record.childLogPath === "string" ? { childLogPath: record.childLogPath } : {}),
    ...(typeof record.childControlPath === "string" ? { childControlPath: record.childControlPath } : {}),
    ...(typeof record.childPromptPath === "string" ? { childPromptPath: record.childPromptPath } : {}),
    ...(Array.isArray(record.parentMessages) ? { parentMessages: record.parentMessages as ParentMessage[] } : {}),
    ...(typeof record.parentCollectedAt === "string" ? { parentCollectedAt: record.parentCollectedAt } : {}),
    legacyWorkspace: workspace,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString(),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
  };
  validateRecord(migrated);
  return migrated;
}

function legacyWorkspace(record: Record<string, unknown>): WorkspaceAttachment {
  if (record.version === 2 && isRecord(record.workspace)) {
    const workspace = record.workspace as unknown as WorkspaceAttachment;
    if (workspace.backend !== "jj" && workspace.backend !== "git") {
      throw new Error("Invalid legacy delegation workspace.");
    }
    return workspace;
  }
  for (const field of [
    "parentWorkspace",
    "repoRoot",
    "baseChangeId",
    "childWorkspace",
    "childWorkspacePath",
    "childRootChangeId",
  ]) requiredLegacyString(record[field], field);
  return {
    backend: "jj",
    purpose: "delegation",
    repoRoot: record.repoRoot as string,
    sourceWorkspace: record.parentWorkspace as string,
    baseChangeId: record.baseChangeId as string,
    name: record.childWorkspace as string,
    path: record.childWorkspacePath as string,
    rootChangeId: record.childRootChangeId as string,
  };
}

function validateRecord(record: DelegationRecord): void {
  if (!record.id || !record.parentSessionId || !record.cwd || !record.agent?.name) {
    throw new Error("Invalid delegation record.");
  }
  if (!record.task?.objective || !record.execution?.phase) throw new Error("Invalid delegation record.");
  if (record.execution.phase === "awaiting_parent" && !record.execution.question?.id) {
    throw new Error("Awaiting-parent delegation is missing its question.");
  }
  if (record.workspace) {
    if (record.workspace.attachment.purpose !== "delegation") {
      throw new Error("Delegated workspace must have delegation purpose.");
    }
    if (record.cwd !== record.workspace.attachment.path) {
      throw new Error("Delegated workspace path must match the child cwd.");
    }
    if (record.workspace.phase === "attention_required") {
      if (!record.workspace.reason.trim() || !record.workspace.tip?.id) {
        throw new Error("Attention-required workspace state must include its reason and captured tip.");
      }
      if (record.workspace.operation === "cleanup" && !record.workspace.integratedAt) {
        throw new Error("Cleanup attention state must retain its integration timestamp.");
      }
    }
    if (
      (record.workspace.phase === "integrated" || record.workspace.phase === "cleaned")
      && (!record.workspace.tip?.id || !record.workspace.integratedAt)
    ) {
      throw new Error("Integrated workspace state must retain its tip and integration timestamp.");
    }
  }
}

function legacyOutcome(state: string): ChildReport["outcome"] {
  if (state === "completed" || state === "blocked" || state === "failed" || state === "cancelled") {
    return state;
  }
  return state === "abandoned" ? "cancelled" : "completed";
}

function requiredLegacyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid legacy delegation field: ${field}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Waiting for children was cancelled."));
    }, { once: true });
  });
}
