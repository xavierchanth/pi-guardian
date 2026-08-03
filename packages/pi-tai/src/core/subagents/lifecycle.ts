import { CAPABILITY_NAMES, type CapabilityName } from "./capabilities.ts";
import type { BackendName } from "./domain.ts";

export const SUBAGENT_LIFECYCLE_ENTRY = "pi-tai-subagent-lifecycle";
export const SUBAGENT_LIFECYCLE_VERSION = 2 as const;

export type ResumeHandle =
  | { kind: "pi_session_file"; value: string }
  | { kind: "claude_session"; value: string }
  | { kind: "codex_thread"; value: string };

interface Fact {
  version: 1 | 2;
  durableId: string;
  generation: number;
  at: string;
}
export type LifecycleAudience = "manager" | "user" | "system";
export interface LifecycleAttachment {
  readonly kind: "artifact";
  readonly ref: string;
}

export type LifecycleEvent =
  | (Fact & {
      version: 1;
      type: "spawn_intent";
      displayId: string;
      sequence: number;
      backend: BackendName;
      title: string;
      cwd: string;
      rootSessionId?: string;
    })
  | (Fact & { version: 1; type: "running"; resumeHandle?: ResumeHandle })
  | (Fact & { version: 1; type: "terminal"; disposition: "done" | "failed" | "interrupted" })
  | (Fact & {
      version: 2;
      type: "spawn_intent";
      displayId: string;
      sequence: number;
      backend: BackendName;
      title: string;
      rootSessionId?: string;
      backendConfig: {
        model?: string;
        provider?: string;
        effort?: string;
        tools?: readonly string[];
      };
      workspace: { cwd: string; workspaceId?: string };
      capability?: CapabilityName;
      audience?: LifecycleAudience;
      attachments?: readonly LifecycleAttachment[];
    })
  | (Fact & {
      version: 2;
      type: "charter";
      charter: string;
      audience: LifecycleAudience;
      attachments?: readonly LifecycleAttachment[];
    })
  | (Fact & { version: 2; type: "running" })
  | (Fact & { version: 2; type: "resume_handle_discovered"; resumeHandle: ResumeHandle })
  | (Fact & { version: 2; type: "generation_advanced"; previousGeneration: number })
  | (Fact & {
      version: 2;
      type: "terminal";
      disposition: "done" | "failed" | "interrupted" | "cancelled";
      report?: string;
      delivery?: "pending" | "delivered" | "dropped";
      audience?: LifecycleAudience;
      attachments?: readonly LifecycleAttachment[];
    })
  | (Fact & { version: 2; type: "archived"; reason?: string })
  | (Fact & { version: 2; type: "result_consumed"; audience: LifecycleAudience })
  | (Fact & { version: 2; type: "result_dropped"; reason: string });

export interface LifecycleRecord {
  readonly durableId: string;
  readonly displayId: string;
  readonly sequence: number;
  readonly generation: number;
  readonly backend: BackendName;
  readonly title: string;
  readonly cwd: string;
  readonly rootSessionId?: string;
  readonly disposition:
    | "intent"
    | "running"
    | "done"
    | "failed"
    | "interrupted"
    | "cancelled"
    | "archived";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resumeHandle?: ResumeHandle;
  readonly piSessionFile?: string;
  readonly backendConfig?: {
    model?: string;
    provider?: string;
    effort?: string;
    tools?: readonly string[];
  };
  readonly workspaceId?: string;
  readonly capability?: CapabilityName;
  readonly charter?: string;
  readonly audience?: LifecycleAudience;
  readonly attachments?: readonly LifecycleAttachment[];
  readonly report?: string;
  readonly delivery?: "pending" | "delivered" | "dropped";
  readonly consumed?: boolean;
  readonly dropReason?: string;
  readonly archivedAt?: string;
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

/** Strict fold: v1 remains readable; malformed and unknown-version facts are quarantined. */
export function foldLifecycle(entries: readonly unknown[]): LifecycleProjection {
  const records = new Map<string, LifecycleRecord>();
  const rejected: unknown[] = [];
  let maxSequence = 0;
  for (const raw of entries) {
    if (!isEvent(raw)) {
      rejected.push(raw);
      continue;
    }
    const e = raw;
    if (e.type === "spawn_intent") {
      if (records.has(e.durableId) || e.displayId !== `sa-${e.sequence}` || e.generation < 1) {
        rejected.push(raw);
        continue;
      }
      const cwd = e.version === 1 ? e.cwd : e.workspace.cwd;
      records.set(e.durableId, {
        durableId: e.durableId,
        displayId: e.displayId,
        sequence: e.sequence,
        generation: e.generation,
        backend: e.backend,
        title: e.title,
        cwd,
        ...(e.rootSessionId ? { rootSessionId: e.rootSessionId } : {}),
        disposition: "intent",
        createdAt: e.at,
        updatedAt: e.at,
        ...(e.version === 2
          ? {
              backendConfig: e.backendConfig,
              ...(e.workspace.workspaceId ? { workspaceId: e.workspace.workspaceId } : {}),
              ...(e.capability ? { capability: e.capability } : {}),
              ...(e.audience ? { audience: e.audience } : {}),
              ...(e.attachments ? { attachments: e.attachments } : {}),
            }
          : {}),
      });
      maxSequence = Math.max(maxSequence, e.sequence);
      continue;
    }
    const prior = records.get(e.durableId);
    if (!prior) {
      rejected.push(raw);
      continue;
    }
    if (e.type === "charter") {
      records.set(e.durableId, {
        ...prior,
        charter: e.charter,
        audience: e.audience,
        ...(e.attachments ? { attachments: e.attachments } : {}),
        updatedAt: e.at,
      });
      continue;
    }
    if (e.type === "archived") {
      records.set(e.durableId, { ...prior, disposition: "archived", updatedAt: e.at });
      continue;
    }
    if (e.type === "result_consumed") {
      records.set(e.durableId, { ...prior, consumed: true, audience: e.audience, updatedAt: e.at });
      continue;
    }
    if (e.type === "result_dropped") {
      records.set(e.durableId, {
        ...prior,
        delivery: "dropped",
        dropReason: e.reason,
        updatedAt: e.at,
      });
      continue;
    }
    if (e.type === "generation_advanced") {
      if (
        e.generation !== prior.generation + 1 ||
        e.previousGeneration !== prior.generation ||
        !["done", "failed", "interrupted", "cancelled"].includes(prior.disposition)
      ) {
        rejected.push(raw);
        continue;
      }
      records.set(e.durableId, {
        ...prior,
        generation: e.generation,
        disposition: "intent",
        updatedAt: e.at,
      });
      continue;
    }
    if (e.generation !== prior.generation) {
      rejected.push(raw);
      continue;
    }
    if (e.type === "resume_handle_discovered") {
      if (prior.disposition !== "running" || !handleMatches(prior.backend, e.resumeHandle)) {
        rejected.push(raw);
        continue;
      }
      records.set(e.durableId, {
        ...prior,
        resumeHandle: e.resumeHandle,
        updatedAt: e.at,
        ...(e.resumeHandle.kind === "pi_session_file"
          ? { piSessionFile: e.resumeHandle.value }
          : {}),
      });
      continue;
    }
    if (e.type === "running") {
      if (
        e.version === 1
          ? !["intent", "running", "done", "failed", "interrupted"].includes(prior.disposition)
          : prior.disposition !== "intent"
      ) {
        rejected.push(raw);
        continue;
      }
      const h = e.version === 1 ? e.resumeHandle : undefined;
      if (h && !handleMatches(prior.backend, h)) {
        rejected.push(raw);
        continue;
      }
      records.set(e.durableId, {
        ...prior,
        disposition: "running",
        updatedAt: e.at,
        ...(h ? { resumeHandle: h } : {}),
        ...(h?.kind === "pi_session_file" ? { piSessionFile: h.value } : {}),
      });
      continue;
    }
    if (prior.disposition !== "running") {
      rejected.push(raw);
      continue;
    }
    records.set(e.durableId, {
      ...prior,
      disposition: e.disposition,
      ...(e.version === 2 && e.report !== undefined ? { report: e.report } : {}),
      ...(e.version === 2 && e.delivery !== undefined ? { delivery: e.delivery } : {}),
      ...(e.version === 2 && e.audience !== undefined ? { audience: e.audience } : {}),
      ...(e.version === 2 && e.attachments !== undefined ? { attachments: e.attachments } : {}),
      updatedAt: e.at,
    });
  }
  return { records, maxSequence, rejected };
}
function handleMatches(b: BackendName, h: ResumeHandle): boolean {
  return (
    h.value.length > 0 &&
    h.kind ===
      ({ pi: "pi_session_file", claude: "claude_session", codex: "codex_thread" } as const)[b]
  );
}
function isEvent(v: unknown): v is LifecycleEvent {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  if ((e.version !== 1 && e.version !== 2) || typeof e.type !== "string") return false;
  const common = ["version", "type", "durableId", "generation", "at"];
  const variants: Record<string, readonly string[]> =
    e.version === 1
      ? {
          spawn_intent: ["displayId", "sequence", "backend", "title", "cwd", "rootSessionId"],
          running: ["resumeHandle"],
          terminal: ["disposition"],
        }
      : {
          spawn_intent: [
            "displayId",
            "sequence",
            "backend",
            "title",
            "rootSessionId",
            "backendConfig",
            "workspace",
            "capability",
            "audience",
            "attachments",
          ],
          charter: ["charter", "audience", "attachments"],
          running: [],
          resume_handle_discovered: ["resumeHandle"],
          generation_advanced: ["previousGeneration"],
          terminal: ["disposition", "report", "delivery", "audience", "attachments"],
          archived: ["reason"],
          result_consumed: ["audience"],
          result_dropped: ["reason"],
        };
  const fields = variants[e.type];
  if (!fields || !exactKeys(e, [...common, ...fields])) return false;
  if (
    typeof e.durableId !== "string" ||
    !Number.isInteger(e.generation) ||
    typeof e.at !== "string"
  )
    return false;
  if (e.type === "spawn_intent") {
    if (
      typeof e.displayId !== "string" ||
      !Number.isInteger(e.sequence) ||
      !["pi", "claude", "codex"].includes(e.backend as string) ||
      typeof e.title !== "string" ||
      (e.rootSessionId !== undefined && typeof e.rootSessionId !== "string")
    )
      return false;
    if (e.version === 1) return typeof e.cwd === "string";
    const w = record(e.workspace),
      c = record(e.backendConfig);
    return (
      !!w &&
      exactKeys(w, ["cwd", "workspaceId"]) &&
      typeof w.cwd === "string" &&
      (w.workspaceId === undefined || typeof w.workspaceId === "string") &&
      !!c &&
      exactKeys(c, ["model", "provider", "effort", "tools"]) &&
      optionalStrings(c, ["model", "provider", "effort"]) &&
      (c.tools === undefined ||
        (Array.isArray(c.tools) && c.tools.every((x) => typeof x === "string"))) &&
      (e.capability === undefined || CAPABILITY_NAMES.includes(e.capability as CapabilityName)) &&
      (e.audience === undefined || isAudience(e.audience)) &&
      (e.attachments === undefined || isAttachments(e.attachments))
    );
  }
  if (e.type === "running")
    return e.version === 2 || e.resumeHandle === undefined || isHandle(e.resumeHandle);
  if (e.type === "resume_handle_discovered") return e.version === 2 && isHandle(e.resumeHandle);
  if (e.type === "generation_advanced")
    return e.version === 2 && Number.isInteger(e.previousGeneration);
  if (e.type === "charter")
    return (
      e.version === 2 &&
      typeof e.charter === "string" &&
      isAudience(e.audience) &&
      (e.attachments === undefined || isAttachments(e.attachments))
    );
  if (e.type === "archived")
    return e.version === 2 && (e.reason === undefined || typeof e.reason === "string");
  if (e.type === "result_consumed") return e.version === 2 && isAudience(e.audience);
  if (e.type === "result_dropped") return e.version === 2 && typeof e.reason === "string";
  const dispositions =
    e.version === 1
      ? ["done", "failed", "interrupted"]
      : ["done", "failed", "interrupted", "cancelled"];
  return (
    e.type === "terminal" &&
    dispositions.includes(e.disposition as string) &&
    (e.report === undefined || typeof e.report === "string") &&
    (e.delivery === undefined ||
      ["pending", "delivered", "dropped"].includes(e.delivery as string)) &&
    (e.audience === undefined || isAudience(e.audience)) &&
    (e.attachments === undefined || isAttachments(e.attachments))
  );
}
function record(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}
function exactKeys(o: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(o).every((key) => allowed.includes(key));
}
function isAudience(v: unknown): v is LifecycleAudience {
  return v === "manager" || v === "user" || v === "system";
}
function isAttachments(v: unknown): v is readonly LifecycleAttachment[] {
  return (
    Array.isArray(v) &&
    v.every((x) => {
      const a = record(x);
      return (
        !!a &&
        exactKeys(a, ["kind", "ref"]) &&
        a.kind === "artifact" &&
        typeof a.ref === "string" &&
        a.ref.length > 0
      );
    })
  );
}
function optionalStrings(o: Record<string, unknown>, ks: string[]): boolean {
  return ks.every((k) => o[k] === undefined || typeof o[k] === "string");
}
function isHandle(v: unknown): v is ResumeHandle {
  if (!v || typeof v !== "object") return false;
  const h = v as Record<string, unknown>;
  return (
    (h.kind === "pi_session_file" || h.kind === "claude_session" || h.kind === "codex_thread") &&
    typeof h.value === "string" &&
    h.value.length > 0 &&
    h.value.trim() === h.value &&
    exactKeys(h, ["kind", "value"])
  );
}

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
    return (this.sessionManager.getBranch?.() ?? []).flatMap((entry) => {
      const e = entry as { type?: string; customType?: string; data?: unknown; details?: unknown };
      return e.customType === SUBAGENT_LIFECYCLE_ENTRY || e.type === SUBAGENT_LIFECYCLE_ENTRY
        ? [e.data ?? e.details]
        : [];
    });
  }
  async append(event: LifecycleEvent): Promise<void> {
    if (typeof this.pi.appendEntry !== "function")
      throw new Error("This Pi host cannot persist subagent lifecycle entries.");
    this.pi.appendEntry(SUBAGENT_LIFECYCLE_ENTRY, event);
  }
}
