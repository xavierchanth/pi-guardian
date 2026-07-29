import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorkspaceId, WorkspaceRecord } from "./domain.ts";

/**
 * One JSON document holding every managed workspace record.
 *
 * Records are small and few (bounded by the subagent concurrency cap plus
 * whatever a crash left behind), so a single atomically-replaced file is both
 * simpler and safer than per-record files with their own partial-write states.
 */
export interface WorkspaceRegistryPort {
  list(): Promise<WorkspaceRecord[]>;
  get(id: WorkspaceId): Promise<WorkspaceRecord | undefined>;
  put(record: WorkspaceRecord): Promise<void>;
  remove(id: WorkspaceId): Promise<void>;
}

export class FileWorkspaceRegistry implements WorkspaceRegistryPort {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(stateRoot: string) {
    this.file = join(stateRoot, "workspaces.json");
  }

  async list(): Promise<WorkspaceRecord[]> {
    return this.read();
  }

  async get(id: WorkspaceId): Promise<WorkspaceRecord | undefined> {
    return (await this.read()).find((record) => record.id === id);
  }

  put(record: WorkspaceRecord): Promise<void> {
    return this.mutate((records) => [...records.filter((item) => item.id !== record.id), record]);
  }

  remove(id: WorkspaceId): Promise<void> {
    return this.mutate((records) => records.filter((record) => record.id !== id));
  }

  private async read(): Promise<WorkspaceRecord[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
      return Array.isArray(parsed) ? (parsed as WorkspaceRecord[]) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /** Serialised through `queue` so concurrent settle hooks cannot lose a record. */
  private mutate(update: (records: WorkspaceRecord[]) => WorkspaceRecord[]): Promise<void> {
    const next = this.queue.then(async () => {
      const records = update(await this.read());
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.file);
    });
    this.queue = next.catch(() => {});
    return next;
  }
}

export class InMemoryWorkspaceRegistry implements WorkspaceRegistryPort {
  private readonly records = new Map<WorkspaceId, WorkspaceRecord>();

  async list(): Promise<WorkspaceRecord[]> { return [...this.records.values()]; }
  async get(id: WorkspaceId): Promise<WorkspaceRecord | undefined> { return this.records.get(id); }
  async put(record: WorkspaceRecord): Promise<void> { this.records.set(record.id, record); }
  async remove(id: WorkspaceId): Promise<void> { this.records.delete(id); }
}
