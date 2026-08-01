import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  /** Serializes a complete custody/graph operation across processes. */
  withOperationLock<T>(operation: () => Promise<T>): Promise<T>;
}

export class FileWorkspaceRegistry implements WorkspaceRegistryPort {
  private readonly file: string;
  private readonly lockFile: string;
  private readonly operationLockFile: string;
  private queue: Promise<unknown> = Promise.resolve();
  private operationQueue: Promise<unknown> = Promise.resolve();

  constructor(stateRoot: string) {
    this.file = join(stateRoot, "workspaces.json");
    this.lockFile = `${this.file}.lock`;
    this.operationLockFile = `${this.file}.operation.lock`;
  }

  withOperationLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await this.acquireLock(this.operationLockFile, 10_000);
      try {
        return await operation();
      } finally {
        await rm(this.operationLockFile, { force: true });
      }
    });
    this.operationQueue = next.catch(() => {});
    return next;
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
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await this.acquireLock(this.lockFile, 2_000);
      try {
        // Read only after obtaining the cross-process lock: otherwise a writer
        // can replace the document between our read and rename.
        const records = update(await this.read());
        const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, this.file);
      } finally {
        await rm(this.lockFile, { force: true });
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }

  private async acquireLock(lockFile: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        const handle = await open(lockFile, "wx", 0o600);
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
        );
        await handle.close();
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Take over only when metadata is valid, old, and its process is
        // definitely gone. Ambiguity fails closed.
        try {
          const owner = JSON.parse(await readFile(lockFile, "utf8")) as {
            pid: number;
            createdAt: string;
          };
          const old = Date.now() - Date.parse(owner.createdAt) > 30_000;
          let alive = true;
          try {
            process.kill(owner.pid, 0);
          } catch (probe) {
            if ((probe as NodeJS.ErrnoException).code === "ESRCH") alive = false;
          }
          if (old && !alive) {
            await rm(lockFile);
            continue;
          }
        } catch {
          /* malformed/racing lock: do not steal it */
        }
        if (Date.now() >= deadline)
          throw new Error(`Timed out waiting for workspace registry lock ${lockFile}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
}

export class InMemoryWorkspaceRegistry implements WorkspaceRegistryPort {
  private readonly records = new Map<WorkspaceId, WorkspaceRecord>();
  private operationQueue: Promise<unknown> = Promise.resolve();

  withOperationLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.catch(() => {});
    return next;
  }

  async list(): Promise<WorkspaceRecord[]> {
    return [...this.records.values()];
  }
  async get(id: WorkspaceId): Promise<WorkspaceRecord | undefined> {
    return this.records.get(id);
  }
  async put(record: WorkspaceRecord): Promise<void> {
    this.records.set(record.id, record);
  }
  async remove(id: WorkspaceId): Promise<void> {
    this.records.delete(id);
  }
}
