import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceId, WorkspaceRecord } from "./domain.ts";

/** One JSON document holding every managed workspace record. */
export interface WorkspaceRegistryPort {
  list(): Promise<WorkspaceRecord[]>;
  get(id: WorkspaceId): Promise<WorkspaceRecord | undefined>;
  put(record: WorkspaceRecord): Promise<void>;
  remove(id: WorkspaceId): Promise<void>;
  withOperationLock<T>(operation: () => Promise<T>): Promise<T>;
}

interface LockOwner {
  readonly pid: number;
  readonly processIdentity: string;
  readonly createdAt: string;
  readonly token: string;
}

export interface FileWorkspaceRegistryOptions {
  /** Test seams; production defaults are deliberately conservative. */
  readonly staleAfterMs?: number;
  readonly retryMs?: number;
  readonly now?: () => number;
  readonly processIdentity?: (pid: number) => Promise<string | undefined>;
}

const execute = promisify(execFile);

async function processStartIdentity(pid: number): Promise<string | undefined> {
  try {
    // Field 22 is the kernel start tick. PID plus start tick survives PID reuse.
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    return `linux:${stat.slice(close + 2).split(" ")[19]}`;
  } catch {
    try {
      // Portable fallback used by macOS/BSD. lstart is stable for process lifetime.
      const { stdout } = await execute("ps", ["-p", String(pid), "-o", "lstart="]);
      const start = stdout.trim();
      return start ? `ps:${start}` : undefined;
    } catch {
      // Without a trustworthy start identity stale locks fail closed.
      return undefined;
    }
  }
}

export class FileWorkspaceRegistry implements WorkspaceRegistryPort {
  private readonly file: string;
  private readonly lockFile: string;
  private readonly operationLockFile: string;
  private readonly staleAfterMs: number;
  private readonly retryMs: number;
  private readonly now: () => number;
  private readonly identity: (pid: number) => Promise<string | undefined>;
  private queue: Promise<unknown> = Promise.resolve();
  private operationQueue: Promise<unknown> = Promise.resolve();

  constructor(stateRoot: string, options: FileWorkspaceRegistryOptions = {}) {
    this.file = join(stateRoot, "workspaces.json");
    this.lockFile = `${this.file}.lock`;
    this.operationLockFile = `${this.file}.operation.lock`;
    this.staleAfterMs = options.staleAfterMs ?? 30_000;
    this.retryMs = options.retryMs ?? 25;
    this.now = options.now ?? Date.now;
    this.identity = options.processIdentity ?? processStartIdentity;
  }

  withOperationLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const owner = await this.acquireLock(this.operationLockFile, 10_000);
      try {
        return await operation();
      } finally {
        await this.releaseLock(this.operationLockFile, owner);
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

  private mutate(update: (records: WorkspaceRecord[]) => WorkspaceRecord[]): Promise<void> {
    const next = this.queue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const owner = await this.acquireLock(this.lockFile, 2_000);
      try {
        const records = update(await this.read());
        const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, this.file);
      } finally {
        await this.releaseLock(this.lockFile, owner);
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }

  /**
   * Directory rename is the claim CAS. The destination is deterministic for the
   * stale token and non-empty, so exactly one contender can move that generation.
   * A delayed contender cannot move a successor because the old claim remains.
   */
  private async acquireLock(lockFile: string, timeoutMs: number): Promise<LockOwner> {
    const deadline = this.now() + timeoutMs;
    while (true) {
      const token = randomUUID();
      try {
        await mkdir(lockFile, { mode: 0o700 });
        const processIdentity = await this.identity(process.pid);
        if (!processIdentity) throw new Error("Cannot establish lock owner process identity");
        const owner: LockOwner = {
          pid: process.pid,
          processIdentity,
          createdAt: new Date(this.now()).toISOString(),
          token,
        };
        await writeFile(join(lockFile, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
        return owner;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          // A crash/failed identity after mkdir leaves an ambiguous lock. Retain it.
          throw error;
        }
      }

      try {
        const owner = JSON.parse(await readFile(join(lockFile, "owner.json"), "utf8")) as LockOwner;
        const valid =
          Number.isInteger(owner.pid) &&
          typeof owner.token === "string" &&
          /^[0-9a-f-]{36}$/.test(owner.token) &&
          typeof owner.processIdentity === "string" &&
          Number.isFinite(Date.parse(owner.createdAt));
        if (valid && this.now() - Date.parse(owner.createdAt) > this.staleAfterMs) {
          const currentIdentity = await this.identity(owner.pid);
          if (currentIdentity !== owner.processIdentity) {
            // The claim name proves the exact observed generation. Existing claim
            // artifacts intentionally prevent replay and are never auto-deleted.
            await rename(lockFile, `${lockFile}.claim-${owner.token}`);
            continue;
          }
        }
      } catch {
        // Malformed, incomplete, racing, or already-claimed locks fail closed.
      }
      if (this.now() >= deadline)
        throw new Error(`Timed out waiting for workspace registry lock ${lockFile}`);
      await new Promise((resolve) => setTimeout(resolve, this.retryMs));
    }
  }

  private async releaseLock(lockFile: string, expected: LockOwner): Promise<void> {
    const owner = JSON.parse(await readFile(join(lockFile, "owner.json"), "utf8")) as LockOwner;
    if (owner.token !== expected.token || owner.processIdentity !== expected.processIdentity) {
      throw new Error(`Refusing to unlock workspace registry lock not owned by this operation`);
    }
    const released = `${lockFile}.release-${expected.token}`;
    // Atomic rename competes safely with takeover. It can never target a successor.
    await rename(lockFile, released);
    await rm(released, { recursive: true });
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
