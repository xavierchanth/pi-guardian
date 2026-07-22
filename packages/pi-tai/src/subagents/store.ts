import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelPreferenceId } from "./domain.ts";

export const DELEGATION_STATES = [
  "created",
  "running",
  "completed",
  "blocked",
  "failed",
  "cancelled",
  "integrated_pending_verification",
  "conflicted",
  "integrated",
  "abandoned",
] as const;
export type DelegationState = (typeof DELEGATION_STATES)[number];

export interface ChildReport {
  outcome: "completed" | "blocked" | "failed" | "cancelled";
  summary: string;
  validation?: string[];
  changedFiles?: string[];
  concerns?: string[];
  childTipChangeId?: string;
  reportedAt: string;
}

export type ChildMessageDelivery = "steer" | "followUp";

export interface ParentMessage {
  message: string;
  delivery: ChildMessageDelivery;
  sentAt: string;
}

export interface DelegationRecord {
  version: 1;
  id: string;
  state: DelegationState;
  task: string;
  modelPreferenceId: ModelPreferenceId | string;
  parentSessionId: string;
  parentSessionFile?: string;
  parentWorkspace: string;
  repoRoot: string;
  baseChangeId: string;
  childWorkspace: string;
  childWorkspacePath: string;
  childRootChangeId: string;
  childSessionId?: string;
  childSessionFile?: string;
  childPid?: number;
  childLogPath?: string;
  childControlPath?: string;
  parentMessages?: ParentMessage[];
  parentCollectedAt?: string;
  report?: ChildReport;
  conflictFiles?: string[];
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

export class FileDelegationStore implements DelegationStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async create(record: DelegationRecord): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = this.path(record.id);
    try {
      await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, {
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
        version: 1 as const,
        updatedAt: new Date().toISOString(),
      };
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
        await new Promise((resolve) => setTimeout(resolve, 20));
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
  onProgress?: (records: readonly DelegationRecord[]) => void;
}

const RESOLVED_STATES = new Set<DelegationState>([
  "completed",
  "blocked",
  "failed",
  "cancelled",
  "integrated_pending_verification",
  "conflicted",
  "integrated",
  "abandoned",
]);

export function isResolvedDelegation(record: DelegationRecord): boolean {
  return RESOLVED_STATES.has(record.state);
}

export async function waitForChildren(
  store: DelegationStore,
  parentSessionId: string,
  options: WaitForChildrenOptions = {},
): Promise<DelegationRecord[]> {
  const snapshot = (await store.listChildren(parentSessionId))
    .filter((record) => !record.parentCollectedAt)
    .map((record) => record.id);
  if (snapshot.length === 0) return [];

  const interval = options.pollIntervalMs ?? 250;
  while (true) {
    if (options.signal?.aborted) throw new Error("Waiting for children was cancelled.");
    const records = (await Promise.all(snapshot.map((id) => store.get(id))))
      .filter((record): record is DelegationRecord => Boolean(record));
    options.onProgress?.(records);
    if (records.length === snapshot.length && records.every(isResolvedDelegation)) {
      const collectedAt = new Date().toISOString();
      return Promise.all(records.map((record) => store.update(record.id, (current) => ({
        ...current,
        parentCollectedAt: current.parentCollectedAt ?? collectedAt,
      }))));
    }
    await delay(interval, options.signal);
  }
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

function parseRecord(value: unknown): DelegationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid delegation record.");
  }
  const record = value as Partial<DelegationRecord>;
  if (record.version !== 1 || typeof record.id !== "string" || typeof record.state !== "string") {
    throw new Error("Invalid delegation record.");
  }
  if (!DELEGATION_STATES.includes(record.state as DelegationState)) {
    throw new Error(`Invalid delegation state: ${record.state}`);
  }
  return record as DelegationRecord;
}
