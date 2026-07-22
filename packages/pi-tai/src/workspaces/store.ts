import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceAttachment } from "./domain.ts";

export type WorkspaceTransitionState = "allocated" | "switched" | "failed";

export interface WorkspaceTransitionRecord {
  version: 1;
  id: string;
  state: WorkspaceTransitionState;
  sourceSessionId: string;
  sourceSessionFile?: string;
  sourceCwd: string;
  workspace: WorkspaceAttachment;
  successorSessionId?: string;
  successorSessionFile?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceTransitionStore {
  create(record: WorkspaceTransitionRecord): Promise<void>;
  get(id: string): Promise<WorkspaceTransitionRecord | undefined>;
  update(
    id: string,
    update: (record: WorkspaceTransitionRecord) => WorkspaceTransitionRecord,
  ): Promise<WorkspaceTransitionRecord>;
  list(): Promise<WorkspaceTransitionRecord[]>;
}

export class FileWorkspaceTransitionStore implements WorkspaceTransitionStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async create(record: WorkspaceTransitionRecord): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeFile(this.path(record.id), `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  }

  async get(id: string): Promise<WorkspaceTransitionRecord | undefined> {
    try {
      return parseTransition(JSON.parse(await readFile(this.path(id), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async update(
    id: string,
    update: (record: WorkspaceTransitionRecord) => WorkspaceTransitionRecord,
  ): Promise<WorkspaceTransitionRecord> {
    const current = await this.get(id);
    if (!current) throw new Error(`Unknown workspace transition: ${id}`);
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
  }

  async list(): Promise<WorkspaceTransitionRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records = await Promise.all(names
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .map((name) => this.get(name.slice(0, -5))));
    return records.filter((record): record is WorkspaceTransitionRecord => Boolean(record));
  }

  private path(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid workspace transition id: ${id}`);
    return join(this.root, `${id}.json`);
  }
}

function parseTransition(value: unknown): WorkspaceTransitionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid workspace transition record.");
  }
  const record = value as Partial<WorkspaceTransitionRecord>;
  if (record.version !== 1 || typeof record.id !== "string") {
    throw new Error("Invalid workspace transition record.");
  }
  if (record.workspace?.purpose !== "relocation") {
    throw new Error("Invalid relocation workspace attachment.");
  }
  return record as WorkspaceTransitionRecord;
}
