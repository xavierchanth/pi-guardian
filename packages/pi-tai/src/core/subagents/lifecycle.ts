import type { BackendName } from "./domain.ts";

export const SUBAGENT_LIFECYCLE_ENTRY = "pi-tai-subagent-lifecycle";
export const SUBAGENT_LIFECYCLE_VERSION = 1 as const;

export type LifecycleEvent =
  | {
      version: 1;
      type: "spawn_intent";
      durableId: string;
      displayId: string;
      sequence: number;
      generation: number;
      backend: BackendName;
      title: string;
      cwd: string;
      rootSessionId?: string;
      at: string;
    }
  | {
      version: 1;
      type: "running";
      durableId: string;
      generation: number;
      at: string;
      resumeHandle?: {
        kind: "pi_session_file" | "claude_session" | "codex_thread";
        value: string;
      };
    }
  | {
      version: 1;
      type: "terminal";
      durableId: string;
      generation: number;
      disposition: "done" | "failed" | "interrupted";
      at: string;
    };

export interface LifecycleRecord {
  readonly durableId: string;
  readonly displayId: string;
  readonly sequence: number;
  readonly generation: number;
  readonly backend: BackendName;
  readonly title: string;
  readonly cwd: string;
  readonly rootSessionId?: string;
  readonly archivedAt?: string;
  readonly archivedBy?: "user" | "auto_done";
  readonly disposition: "intent" | "running" | "done" | "failed" | "interrupted";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly piSessionFile?: string;
}

export interface LifecycleProjection {
  readonly records: ReadonlyMap<string, LifecycleRecord>;
  readonly maxSequence: number;
  readonly rejected: readonly unknown[];
}

export interface SubagentLifecycleStore {
  load(): Promise<readonly unknown[]>;
  append(event: LifecycleEvent): Promise<void>;
}

/** Strictly folds known v1 facts. Old and unknown entries are quarantined, never guessed. */
export function foldLifecycle(entries: readonly unknown[]): LifecycleProjection {
  const records = new Map<string, LifecycleRecord>();
  const rejected: unknown[] = [];
  let maxSequence = 0;
  for (const raw of entries) {
    if (!isEvent(raw)) {
      rejected.push(raw);
      continue;
    }
    const event = raw;
    if (event.type === "spawn_intent") {
      if (records.has(event.durableId) || event.displayId !== `sa-${event.sequence}`) {
        rejected.push(raw);
        continue;
      }
      records.set(event.durableId, {
        durableId: event.durableId,
        displayId: event.displayId,
        sequence: event.sequence,
        generation: event.generation,
        backend: event.backend,
        title: event.title,
        cwd: event.cwd,
        ...(event.rootSessionId ? { rootSessionId: event.rootSessionId } : {}),
        disposition: "intent",
        createdAt: event.at,
        updatedAt: event.at,
      });
      maxSequence = Math.max(maxSequence, event.sequence);
      continue;
    }
    const prior = records.get(event.durableId);
    if (
      !prior ||
      event.generation !== prior.generation ||
      (event.type === "running"
        ? !["intent", "running", "done", "failed", "interrupted"].includes(prior.disposition)
        : prior.disposition !== "running")
    ) {
      rejected.push(raw);
      continue;
    }
    if (event.type === "running")
      records.set(event.durableId, {
        ...prior,
        disposition: "running",
        updatedAt: event.at,
        ...(event.resumeHandle?.kind === "pi_session_file"
          ? { piSessionFile: event.resumeHandle.value }
          : {}),
      });
    else
      records.set(event.durableId, {
        ...prior,
        disposition: event.disposition,
        updatedAt: event.at,
      });
  }
  return { records, maxSequence, rejected };
}

function isEvent(value: unknown): value is LifecycleEvent {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  if (
    e.version !== 1 ||
    typeof e.type !== "string" ||
    typeof e.durableId !== "string" ||
    typeof e.generation !== "number" ||
    typeof e.at !== "string"
  )
    return false;
  if (e.type === "spawn_intent")
    return (
      typeof e.displayId === "string" &&
      Number.isInteger(e.sequence) &&
      (e.backend === "pi" || e.backend === "claude" || e.backend === "codex") &&
      typeof e.title === "string" &&
      typeof e.cwd === "string" &&
      (e.rootSessionId === undefined || typeof e.rootSessionId === "string")
    );
  if (e.type === "running")
    return (
      e.resumeHandle === undefined ||
      (!!e.resumeHandle &&
        typeof e.resumeHandle === "object" &&
        typeof (e.resumeHandle as Record<string, unknown>).kind === "string" &&
        typeof (e.resumeHandle as Record<string, unknown>).value === "string")
    );
  return (
    e.type === "terminal" &&
    (e.disposition === "done" || e.disposition === "failed" || e.disposition === "interrupted")
  );
}

/** Present Pi adapter only; this intentionally makes no claim of Host authority. */
export class PiBranchLifecycleStore implements SubagentLifecycleStore {
  private readonly pi: { appendEntry?: (type: string, data: unknown) => void };
  private readonly sessionManager: { getBranch?: () => readonly unknown[] };
  constructor(
    pi: { appendEntry?: (type: string, data: unknown) => void },
    sessionManager: { getBranch?: () => readonly unknown[] },
  ) {
    this.pi = pi;
    this.sessionManager = sessionManager;
  }
  async load(): Promise<readonly unknown[]> {
    const branch = this.sessionManager.getBranch?.() ?? [];
    return branch.flatMap((entry) => {
      const e = entry as {
        type?: string;
        customType?: string;
        data?: unknown;
        details?: unknown;
      };
      if (e.customType === SUBAGENT_LIFECYCLE_ENTRY || e.type === SUBAGENT_LIFECYCLE_ENTRY)
        return [e.data ?? e.details];
      return [];
    });
  }
  async append(event: LifecycleEvent): Promise<void> {
    if (typeof this.pi.appendEntry !== "function")
      throw new Error("This Pi host cannot persist subagent lifecycle entries.");
    this.pi.appendEntry(SUBAGENT_LIFECYCLE_ENTRY, event);
  }
}
