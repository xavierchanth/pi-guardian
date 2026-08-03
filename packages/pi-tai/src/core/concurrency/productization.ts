import { createHash } from "node:crypto";

export const CONCURRENCY_STATE_VERSION = 1 as const;
export const CONCURRENCY_PROJECTION_VERSION = 1 as const;

export type RepositoryInitializationMode = "existing_jj" | "colocate_git" | "new_colocated";

export interface RepositoryEnrollmentPlanV1 {
  readonly version: 1;
  readonly planId: string;
  readonly repositoryPath: string;
  readonly canonicalRepositoryPath?: string;
  readonly initializationMode: RepositoryInitializationMode;
  readonly managedWorkspaceRoot: string;
  readonly privateRevsetAlias: "pi_tai_private()";
  readonly privateRevsetExpression: 'description(glob:"pi-tai:*")';
  readonly priorPrivateCommits: string;
  readonly nextPrivateCommits: string;
  readonly planDigest: string;
}

export interface RepositoryEnrollmentReceiptV1 {
  readonly enrollmentId: string;
  readonly repositoryId: string;
  readonly canonicalRepositoryPath: string;
  readonly managedWorkspaceRoot: string;
  readonly initializationMode: RepositoryInitializationMode;
  readonly planDigest: string;
  readonly configDigest: string;
  readonly userAuthorizationId: string;
  readonly enrolledAt: string;
  readonly receiptDigest: string;
}

export type RepositoryEnrollmentV1 =
  | {
      readonly version: 1;
      readonly phase: "planned";
      readonly plan: RepositoryEnrollmentPlanV1;
      readonly plannedAt: string;
    }
  | {
      readonly version: 1;
      readonly phase: "initializing";
      readonly plan: RepositoryEnrollmentPlanV1;
      readonly userAuthorizationId: string;
      readonly boundary:
        | "authorized"
        | "repository_initialized"
        | "alias_configured"
        | "private_commits_configured"
        | "workspace_root_created";
      readonly startedAt: string;
      readonly evidence: unknown;
    }
  | {
      readonly version: 1;
      readonly phase: "ready";
      readonly receipt: RepositoryEnrollmentReceiptV1;
    }
  | {
      readonly version: 1;
      readonly phase: "repair_required";
      readonly receipt: RepositoryEnrollmentReceiptV1;
      readonly reason: string;
      readonly observedAt: string;
    }
  | {
      readonly version: 1;
      readonly phase: "attention_required";
      readonly plan?: RepositoryEnrollmentPlanV1;
      readonly lastSafeBoundary: string;
      readonly reason: string;
      readonly evidence: unknown;
      readonly stoppedAt: string;
    }
  | {
      readonly version: 1;
      readonly phase: "revoked";
      readonly receipt: RepositoryEnrollmentReceiptV1;
      readonly revokedAt: string;
      readonly reason: string;
    };

export interface SessionWorkspaceIdentityV1 {
  readonly repositoryId: string;
  readonly rootSessionId: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly path: string;
  readonly sourceWorkspaceName: string;
  /** Legacy wire observations; new session custody does not persist source @ or @-. */
  readonly sourceWorkspaceChangeId?: string;
  readonly baseChangeId?: string;
  readonly orchestrationChangeId: string;
}

export type SessionWorkspaceCustodyV1 =
  | {
      readonly version: 1;
      readonly phase: "allocating";
      readonly repositoryId: string;
      readonly rootSessionId: string;
      readonly workspaceId: string;
      readonly operationId: string;
      readonly plannedPath: string;
      readonly startedAt: string;
    }
  | {
      readonly version: 1;
      readonly phase: "ready";
      readonly identity: SessionWorkspaceIdentityV1;
      readonly generation: number;
      readonly verifiedAt: string;
    }
  | {
      readonly version: 1;
      readonly phase: "interrupted";
      readonly identity: SessionWorkspaceIdentityV1;
      readonly priorGeneration: number;
      readonly reason: string;
      readonly interruptedAt: string;
    }
  | {
      readonly version: 1;
      readonly phase: "cleanup_pending";
      readonly identity: SessionWorkspaceIdentityV1;
      readonly reason: string;
      readonly requestedAt: string;
    }
  | {
      readonly version: 1;
      readonly phase: "retired";
      readonly identity: SessionWorkspaceIdentityV1;
      readonly retiredAt: string;
    }
  | {
      readonly version: 1;
      readonly phase: "attention_required";
      readonly repositoryId: string;
      readonly rootSessionId: string;
      readonly workspaceId: string;
      readonly identity?: SessionWorkspaceIdentityV1;
      readonly lastSafeBoundary: string;
      readonly reason: string;
      readonly evidence: unknown;
      readonly stoppedAt: string;
    };

export type RepositoryMutationLeaseV1 =
  | { readonly phase: "available"; readonly repositoryId: string; readonly generation: number }
  | {
      readonly phase: "leased";
      readonly repositoryId: string;
      readonly generation: number;
      readonly leaseId: string;
      readonly rootSessionId: string;
      readonly runtimeGeneration: number;
      readonly operationId: string;
      readonly acquiredAt: string;
    }
  | {
      readonly phase: "interrupted";
      readonly repositoryId: string;
      readonly generation: number;
      readonly priorLeaseId: string;
      readonly priorRootSessionId: string;
      readonly priorRuntimeGeneration: number;
      readonly operationId: string;
      readonly reason: string;
      readonly interruptedAt: string;
    };

export interface ExactUsageEntryV1 {
  readonly usageEventId: string;
  readonly rootSessionId: string;
  readonly contextId: string;
  readonly executionCycleId: string;
  readonly messageId: string;
  readonly provider: string;
  readonly model: string;
  readonly role: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
  readonly recordedAt: string;
}

export interface UsageTelemetryGapV1 {
  readonly gapId: string;
  readonly rootSessionId: string;
  readonly contextId: string;
  readonly executionCycleId: string;
  readonly messageId?: string;
  readonly reason: "missing_message_usage" | "missing_model_identity" | "legacy_estimate_only";
  readonly observedAt: string;
}

export interface UsageTotalsV1 {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
}

export interface ChildProjectionV1 {
  readonly contextId: string;
  readonly parentContextId?: string;
  readonly taskId?: string;
  readonly role: string;
  readonly objective: string;
  readonly phase: string;
  readonly executionCycleId?: string;
  readonly workspaceId?: string;
  readonly questionId?: string;
  readonly terminalEventId?: string;
  readonly updatedAt: string;
}

export interface TaskProjectionV1 {
  readonly taskId: string;
  readonly parentTaskId?: string;
  readonly ownerRole: string;
  readonly objective: string;
  readonly executionPhase: string;
  readonly childTaskCount: number;
  readonly planRevisionCount: number;
  readonly directionCount: number;
  readonly updatedAt: string;
}

export interface WorkspaceProjectionV1 {
  readonly workspaceId: string;
  readonly taskId?: string;
  readonly phase: string;
  readonly changedPathCount?: number;
  readonly findingCounts?: Readonly<Record<"p0" | "p1" | "p2" | "p3" | "p4", number>>;
  readonly receiptDigests: readonly string[];
  readonly incidentSummary?: string;
  readonly updatedAt: string;
}

export interface ConcurrencyProjectionV1 {
  readonly version: 1;
  readonly rootSessionId: string;
  readonly revision: number;
  readonly generatedAt: string;
  readonly children: readonly ChildProjectionV1[];
  readonly inactiveChildCount: number;
  readonly tasks: readonly TaskProjectionV1[];
  readonly inactiveTaskCount: number;
  readonly workspaces: readonly WorkspaceProjectionV1[];
  readonly activeClaimCount: number;
  readonly unansweredQuestionCount: number;
  readonly usage: UsageTotalsV1;
  readonly telemetryGapCount: number;
  readonly truncated: boolean;
}

export interface ConcurrencyTransactionV1 {
  readonly version: 1;
  readonly transactionId: string;
  readonly rootSessionId: string;
  readonly runtimeGeneration: number;
  readonly expectedRevision: number;
  readonly events: readonly {
    readonly eventId: string;
    readonly type: string;
    readonly payload: unknown;
  }[];
  readonly state: unknown;
  readonly projection: ConcurrencyProjectionV1;
}

export function enrollmentPlanDigest(
  input: Omit<RepositoryEnrollmentPlanV1, "planDigest">,
): string {
  return digest(input);
}

export function enrollmentReceiptDigest(
  input: Omit<RepositoryEnrollmentReceiptV1, "receiptDigest">,
): string {
  return digest(input);
}

export function validateConcurrencyProjection(
  value: ConcurrencyProjectionV1,
): ConcurrencyProjectionV1 {
  if (value.version !== CONCURRENCY_PROJECTION_VERSION)
    throw new Error("Unsupported concurrency projection version.");
  managedId(value.rootSessionId, "root session");
  safeCounter(value.revision, "projection revision");
  if (value.children.length > 256)
    throw new Error("Concurrency projection exceeds 256 child summaries.");
  if (value.tasks.length > 256)
    throw new Error("Concurrency projection exceeds 256 task summaries.");
  if (value.workspaces.length > 256)
    throw new Error("Concurrency projection exceeds 256 workspace summaries.");
  for (const child of value.children) {
    managedId(child.contextId, "child context");
    if (child.parentContextId) managedId(child.parentContextId, "parent context");
    if (child.executionCycleId) managedId(child.executionCycleId, "execution cycle");
  }
  for (const workspace of value.workspaces) managedId(workspace.workspaceId, "workspace");
  for (const amount of Object.values(value.usage)) nonnegative(amount, "usage total");
  safeCounter(value.inactiveChildCount, "inactive child count");
  safeCounter(value.inactiveTaskCount, "inactive task count");
  safeCounter(value.activeClaimCount, "active claim count");
  safeCounter(value.unansweredQuestionCount, "question count");
  safeCounter(value.telemetryGapCount, "telemetry gap count");
  return value;
}

export function validateConcurrencyTransaction(
  value: ConcurrencyTransactionV1,
): ConcurrencyTransactionV1 {
  if (value.version !== CONCURRENCY_STATE_VERSION)
    throw new Error("Unsupported concurrency transaction version.");
  managedId(value.transactionId, "transaction");
  managedId(value.rootSessionId, "root session");
  safeCounter(value.runtimeGeneration, "runtime generation");
  safeCounter(value.expectedRevision, "expected revision");
  if (value.events.length === 0 || value.events.length > 64)
    throw new Error("Concurrency transaction must contain 1 to 64 events.");
  const ids = new Set<string>();
  for (const event of value.events) {
    managedId(event.eventId, "event");
    if (ids.has(event.eventId)) throw new Error(`Duplicate concurrency event: ${event.eventId}`);
    ids.add(event.eventId);
    if (!event.type.trim() || Buffer.byteLength(event.type, "utf8") > 128)
      throw new Error("Concurrency event type is invalid.");
  }
  if (value.projection.rootSessionId !== value.rootSessionId)
    throw new Error("Concurrency transaction projection belongs to another root session.");
  if (value.projection.revision !== value.expectedRevision + 1)
    throw new Error("Concurrency projection revision must advance exactly once.");
  validateConcurrencyProjection(value.projection);
  if (value.state === undefined)
    throw new Error("Concurrency transaction requires strict aggregate state.");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 1024 * 1024)
    throw new Error("Concurrency transaction exceeds 1 MiB.");
  return value;
}

export function sumExactUsage(entries: readonly ExactUsageEntryV1[]): UsageTotalsV1 {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const seen = new Set<string>();
  for (const entry of entries) {
    managedId(entry.usageEventId, "usage event");
    if (seen.has(entry.usageEventId)) continue;
    seen.add(entry.usageEventId);
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      nonnegative(entry[key], `usage ${key}`);
      total[key] += entry[key];
    }
    for (const value of Object.values(entry.cost)) nonnegative(value, "usage cost");
    total.cost += entry.cost.total;
  }
  return total;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function managedId(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value))
    throw new Error(`Invalid ${label} ID: ${value}`);
}
function safeCounter(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a nonnegative safe integer.`);
}
function nonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be nonnegative.`);
}
