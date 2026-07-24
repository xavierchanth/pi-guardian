import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { HostConcurrencyState } from "../concurrency/host-state.ts";

export interface PersistedSharedTargetV1 {
  readonly changeId: string;
  readonly wipChangeId: string;
  readonly ownerContextId: string;
  readonly description: string;
  readonly insertOperationId: string;
  readonly createdAt: string;
}

export interface PersistedPathFingerprintV1 {
  readonly path: string;
  readonly digest: string;
}

interface PersistedClaimBaseV1 {
  readonly claimId: string;
  readonly ownerContextId: string;
  readonly rootSessionId: string;
  readonly targetChangeId: string;
  readonly wipChangeId: string;
  readonly paths: readonly string[];
  readonly queuedAt: string;
}

export type PersistedFileSetClaimV1 = PersistedClaimBaseV1 & (
  | { readonly phase: "queued" }
  | {
      readonly phase: "active";
      readonly acquiredAt: string;
      readonly fingerprints: readonly PersistedPathFingerprintV1[];
      readonly baselinePatchHash: string;
      readonly mutatedPaths: readonly string[];
    }
  | {
      readonly phase: "checkpointing";
      readonly acquiredAt: string;
      readonly fingerprints: readonly PersistedPathFingerprintV1[];
      readonly baselinePatchHash: string;
      readonly mutatedPaths: readonly string[];
      readonly operationId: string;
    }
  | { readonly phase: "released"; readonly releasedAt: string; readonly checkpointOperationId?: string }
  | {
      readonly phase: "interrupted";
      readonly interruptedAt: string;
      readonly priorPhase: "queued" | "active" | "checkpointing";
      readonly reason: string;
      readonly recovery?: {
        readonly fingerprints: readonly PersistedPathFingerprintV1[];
        readonly baselinePatchHash: string;
        readonly mutatedPaths: readonly string[];
        readonly operationId?: string;
      };
    }
  | { readonly phase: "breached"; readonly observedAt: string; readonly reason: string }
);

interface PersistedOperationBaseV1 {
  readonly operationId: string;
  readonly kind: "ensure_wip" | "insert_change" | "checkpoint_change";
  readonly idempotencyKey: string;
  readonly startedAt: string;
  readonly beforeJjOperationId: string;
}

export type PersistedJjOperationV1 = PersistedOperationBaseV1 & (
  | { readonly phase: "started" }
  | { readonly phase: "completed"; readonly completedAt: string; readonly afterJjOperationId: string; readonly receipt: unknown }
  | { readonly phase: "blocked"; readonly blockedAt: string; readonly blocker: unknown }
  | { readonly phase: "unknown"; readonly stoppedAt: string; readonly reason: string }
);

export interface PersistedSharedSourceV1 {
  readonly version: 1;
  readonly sourceId: string;
  readonly repositoryRoot: string;
  readonly workspacePath: string;
  readonly workspaceName: string;
  readonly wip?: {
    readonly changeId: string;
    readonly description: string;
    readonly ensuredOperationId: string;
  };
  readonly targets: readonly PersistedSharedTargetV1[];
  readonly claims: readonly PersistedFileSetClaimV1[];
  readonly operations: readonly PersistedJjOperationV1[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SharedSourceStore {
  create(record: PersistedSharedSourceV1): Promise<void>;
  get(sourceId: string): Promise<PersistedSharedSourceV1 | undefined>;
  list(): Promise<PersistedSharedSourceV1[]>;
  update(
    sourceId: string,
    reducer: (record: PersistedSharedSourceV1) => PersistedSharedSourceV1,
  ): Promise<PersistedSharedSourceV1>;
  interruptLiveClaims(sourceId: string, reason: string, at?: string): Promise<PersistedSharedSourceV1>;
}

export class HostSharedSourceStore implements SharedSourceStore {
  private readonly state: HostConcurrencyState;
  constructor(state: HostConcurrencyState) { this.state = state; }
  async create(record: PersistedSharedSourceV1): Promise<void> {
    const value = validateSharedSource(record);
    await this.state.mutateSegment<PersistedSharedSourceV1>("sharedSources", "source.created", { sourceId: value.sourceId }, (sources) => {
      if (sources.some((source) => source.sourceId === value.sourceId)) throw new Error(`Shared source already exists: ${value.sourceId}`);
      return [...sources, value];
    });
  }
  async get(sourceId: string): Promise<PersistedSharedSourceV1 | undefined> { return (await this.list()).find((source) => source.sourceId === sourceId); }
  async list(): Promise<PersistedSharedSourceV1[]> { return (await this.state.readSegment<PersistedSharedSourceV1>("sharedSources")).map(validateSharedSource); }
  async update(sourceId: string, reducer: (record: PersistedSharedSourceV1) => PersistedSharedSourceV1): Promise<PersistedSharedSourceV1> {
    let output: PersistedSharedSourceV1 | undefined;
    await this.state.mutateSegment<PersistedSharedSourceV1>("sharedSources", "source.replaced", { sourceId }, (sources) => sources.map((source) => {
      if (source.sourceId !== sourceId) return source;
      const next = validateSharedSource(reducer(structuredClone(source))); if (next.sourceId !== sourceId) throw new Error("Shared source update changed identity."); output = next; return next;
    }));
    if (!output) throw new Error(`Unknown shared source: ${sourceId}`); return output;
  }
  interruptLiveClaims(sourceId: string, reason: string, at = new Date().toISOString()): Promise<PersistedSharedSourceV1> {
    return this.update(sourceId, (record) => ({ ...record, claims: record.claims.map((claim): PersistedFileSetClaimV1 => {
      if (claim.phase === "released" || claim.phase === "interrupted" || claim.phase === "breached") return claim;
      return { ...claimBase(claim), phase: "interrupted", priorPhase: claim.phase, reason, interruptedAt: at, ...((claim.phase === "active" || claim.phase === "checkpointing") ? { recovery: { fingerprints: claim.fingerprints, baselinePatchHash: claim.baselinePatchHash, mutatedPaths: claim.mutatedPaths, ...(claim.phase === "checkpointing" ? { operationId: claim.operationId } : {}) } } : {}) };
    }), updatedAt: at }));
  }
}

export class FileSharedSourceStore implements SharedSourceStore {
  readonly root: string;
  private readonly updates = new Map<string, Promise<void>>();

  constructor(root: string) { this.root = resolve(root); }

  async create(record: PersistedSharedSourceV1): Promise<void> {
    const value = validateSharedSource(record);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeFile(this.path(value.sourceId), serialize(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
  }

  async get(sourceId: string): Promise<PersistedSharedSourceV1 | undefined> {
    try {
      return validateSharedSource(JSON.parse(await readFile(this.path(sourceId), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(): Promise<PersistedSharedSourceV1[]> {
    try {
      const output: PersistedSharedSourceV1[] = [];
      for (const name of (await readdir(this.root)).filter((value) => value.endsWith(".json")).sort()) {
        const record = await this.get(name.slice(0, -5));
        if (record) output.push(record);
      }
      return output;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  update(
    sourceId: string,
    reducer: (record: PersistedSharedSourceV1) => PersistedSharedSourceV1,
  ): Promise<PersistedSharedSourceV1> {
    validateManagedId(sourceId, "source");
    const prior = (this.updates.get(sourceId) ?? Promise.resolve()).catch(() => undefined);
    let release!: () => void;
    const current = new Promise<void>((resolveUpdate) => { release = resolveUpdate; });
    const chain = prior.then(() => current);
    this.updates.set(sourceId, chain);
    return prior.then(async () => {
      const existing = await this.get(sourceId);
      if (!existing) throw new Error(`Unknown shared source: ${sourceId}`);
      const next = validateSharedSource(reducer(structuredClone(existing)));
      if (next.sourceId !== sourceId) throw new Error("Shared source update cannot change identity.");
      const temporary = `${this.path(sourceId)}.${randomUUID()}.tmp`;
      await writeFile(temporary, serialize(next), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.path(sourceId));
      return next;
    }).finally(() => {
      release();
      if (this.updates.get(sourceId) === chain) this.updates.delete(sourceId);
    });
  }

  interruptLiveClaims(sourceId: string, reason: string, at = new Date().toISOString()): Promise<PersistedSharedSourceV1> {
    nonempty(reason, "interruption reason");
    return this.update(sourceId, (record) => ({
      ...record,
      claims: record.claims.map((claim): PersistedFileSetClaimV1 => {
        if (claim.phase === "released" || claim.phase === "interrupted" || claim.phase === "breached") return claim;
        return {
          ...claimBase(claim),
          phase: "interrupted",
          priorPhase: claim.phase,
          reason,
          interruptedAt: at,
          ...((claim.phase === "active" || claim.phase === "checkpointing") ? {
            recovery: {
              fingerprints: claim.fingerprints,
              baselinePatchHash: claim.baselinePatchHash,
              mutatedPaths: claim.mutatedPaths,
              ...(claim.phase === "checkpointing" ? { operationId: claim.operationId } : {}),
            },
          } : {}),
        };
      }),
      updatedAt: at,
    }));
  }

  private path(sourceId: string): string {
    validateManagedId(sourceId, "source");
    return join(this.root, `${sourceId}.json`);
  }
}

export function validateSharedSource(input: unknown): PersistedSharedSourceV1 {
  if (!record(input) || input.version !== 1) throw new Error("Shared source record must use version 1.");
  validateManagedId(nonempty(input.sourceId, "sourceId"), "source");
  absolute(nonempty(input.repositoryRoot, "repositoryRoot"), "repositoryRoot");
  absolute(nonempty(input.workspacePath, "workspacePath"), "workspacePath");
  nonempty(input.workspaceName, "workspaceName");
  nonempty(input.createdAt, "createdAt");
  nonempty(input.updatedAt, "updatedAt");
  if (!Array.isArray(input.targets) || !Array.isArray(input.claims) || !Array.isArray(input.operations)) {
    throw new Error("Shared source targets, claims, and operations must be arrays.");
  }
  if (input.wip !== undefined) validateWip(input.wip);
  const targets = new Set<string>();
  for (const target of input.targets) {
    validateTarget(target);
    if (targets.has(target.changeId)) throw new Error(`Duplicate shared target Change ID: ${target.changeId}`);
    targets.add(target.changeId);
  }
  const claims = new Set<string>();
  for (const claim of input.claims) {
    validateClaim(claim);
    if (claims.has(claim.claimId)) throw new Error(`Duplicate file-set claim ID: ${claim.claimId}`);
    claims.add(claim.claimId);
  }
  const operations = new Set<string>();
  for (const operation of input.operations) {
    validateOperation(operation);
    if (operations.has(operation.operationId)) throw new Error(`Duplicate managed JJ operation ID: ${operation.operationId}`);
    operations.add(operation.operationId);
  }
  return input as unknown as PersistedSharedSourceV1;
}

function validateWip(value: unknown): void {
  if (!record(value)) throw new Error("Tracked WIP must be an object.");
  fullChangeId(nonempty(value.changeId, "wip.changeId"));
  nonempty(value.description, "wip.description");
  validateManagedId(nonempty(value.ensuredOperationId, "wip.ensuredOperationId"), "operation");
}

function validateTarget(value: unknown): asserts value is PersistedSharedTargetV1 {
  if (!record(value)) throw new Error("Shared target must be an object.");
  fullChangeId(nonempty(value.changeId, "target.changeId"));
  fullChangeId(nonempty(value.wipChangeId, "target.wipChangeId"));
  validateManagedId(nonempty(value.ownerContextId, "target.ownerContextId"), "owner context");
  nonempty(value.description, "target.description");
  validateManagedId(nonempty(value.insertOperationId, "target.insertOperationId"), "operation");
  nonempty(value.createdAt, "target.createdAt");
}

function validateClaim(value: unknown): asserts value is PersistedFileSetClaimV1 {
  if (!record(value)) throw new Error("File-set claim must be an object.");
  const phase = nonempty(value.phase, "claim.phase");
  if (!["queued", "active", "checkpointing", "released", "interrupted", "breached"].includes(phase)) {
    throw new Error(`Invalid file-set claim phase: ${phase}`);
  }
  validateManagedId(nonempty(value.claimId, "claim.claimId"), "claim");
  validateManagedId(nonempty(value.ownerContextId, "claim.ownerContextId"), "owner context");
  validateManagedId(nonempty(value.rootSessionId, "claim.rootSessionId"), "root session");
  fullChangeId(nonempty(value.targetChangeId, "claim.targetChangeId"));
  fullChangeId(nonempty(value.wipChangeId, "claim.wipChangeId"));
  if (!Array.isArray(value.paths) || value.paths.length === 0) throw new Error("Claim paths must be a nonempty array.");
  let prior = "";
  for (const path of value.paths) {
    const normalized = repositoryPath(nonempty(path, "claim path"));
    if (normalized <= prior) throw new Error("Claim paths must be unique and canonically sorted.");
    prior = normalized;
  }
  nonempty(value.queuedAt, "claim.queuedAt");
  const activeFields = ["acquiredAt", "fingerprints", "baselinePatchHash", "mutatedPaths"] as const;
  const checkpointFields = ["operationId"] as const;
  const releasedFields = ["releasedAt", "checkpointOperationId"] as const;
  const interruptedFields = ["interruptedAt", "priorPhase", "reason", "recovery"] as const;
  const breachedFields = ["observedAt"] as const;
  if (phase === "queued") forbid(value, [...activeFields, ...checkpointFields, ...releasedFields, ...interruptedFields, ...breachedFields], "queued claim");
  if (phase === "active") forbid(value, [...checkpointFields, ...releasedFields, ...interruptedFields, ...breachedFields], "active claim");
  if (phase === "checkpointing") forbid(value, [...releasedFields, ...interruptedFields, ...breachedFields], "checkpointing claim");
  if (phase === "released") forbid(value, [...activeFields, ...checkpointFields, ...interruptedFields, ...breachedFields], "released claim");
  if (phase === "interrupted") forbid(value, [...activeFields, ...checkpointFields, ...releasedFields, ...breachedFields], "interrupted claim");
  if (phase === "breached") forbid(value, [...activeFields, ...checkpointFields, ...releasedFields, "interruptedAt", "priorPhase", "recovery"], "breached claim");
  if (phase === "active" || phase === "checkpointing") {
    nonempty(value.acquiredAt, "claim.acquiredAt");
    if (!Array.isArray(value.fingerprints) || value.fingerprints.length !== value.paths.length) {
      throw new Error(`${phase} claim requires one fingerprint per path.`);
    }
    for (const fingerprint of value.fingerprints) validateFingerprint(fingerprint);
    if (!/^[a-f0-9]{64}$/.test(nonempty(value.baselinePatchHash, "claim.baselinePatchHash"))) {
      throw new Error("Claim baseline patch hash must be SHA-256.");
    }
    if (!Array.isArray(value.mutatedPaths)) throw new Error(`${phase} claim requires mutatedPaths.`);
    for (const path of value.mutatedPaths) repositoryPath(nonempty(path, "claim mutated path"));
  }
  if (phase === "checkpointing") validateManagedId(nonempty(value.operationId, "claim.operationId"), "operation");
  if (phase === "released") {
    nonempty(value.releasedAt, "claim.releasedAt");
    if (value.checkpointOperationId !== undefined) validateManagedId(nonempty(value.checkpointOperationId, "claim.checkpointOperationId"), "operation");
  }
  if (phase === "interrupted") {
    if (!["queued", "active", "checkpointing"].includes(String(value.priorPhase))) throw new Error("Interrupted claim prior phase is invalid.");
    nonempty(value.reason, "claim.reason");
    nonempty(value.interruptedAt, "claim.interruptedAt");
    if (value.recovery !== undefined) {
      if (!record(value.recovery) || !Array.isArray(value.recovery.fingerprints) || !Array.isArray(value.recovery.mutatedPaths)) {
        throw new Error("Interrupted claim recovery evidence is invalid.");
      }
      for (const fingerprint of value.recovery.fingerprints) validateFingerprint(fingerprint);
      if (!/^[a-f0-9]{64}$/.test(nonempty(value.recovery.baselinePatchHash, "claim.recovery.baselinePatchHash"))) {
        throw new Error("Interrupted claim recovery baseline patch hash must be SHA-256.");
      }
      for (const path of value.recovery.mutatedPaths) repositoryPath(nonempty(path, "claim recovery mutated path"));
      if (value.recovery.operationId !== undefined) validateManagedId(nonempty(value.recovery.operationId, "claim.recovery.operationId"), "operation");
    }
  }
  if (phase === "breached") {
    nonempty(value.reason, "claim.reason");
    nonempty(value.observedAt, "claim.observedAt");
  }
}

function claimBase(claim: PersistedFileSetClaimV1): PersistedClaimBaseV1 {
  return {
    claimId: claim.claimId,
    ownerContextId: claim.ownerContextId,
    rootSessionId: claim.rootSessionId,
    targetChangeId: claim.targetChangeId,
    wipChangeId: claim.wipChangeId,
    paths: claim.paths,
    queuedAt: claim.queuedAt,
  };
}

function validateFingerprint(value: unknown): void {
  if (!record(value)) throw new Error("Path fingerprint must be an object.");
  repositoryPath(nonempty(value.path, "fingerprint.path"));
  if (!/^[a-f0-9]{64}$/.test(nonempty(value.digest, "fingerprint.digest"))) throw new Error("Path fingerprint digest must be SHA-256.");
}

function validateOperation(value: unknown): asserts value is PersistedJjOperationV1 {
  if (!record(value)) throw new Error("Managed JJ operation must be an object.");
  const phase = nonempty(value.phase, "operation.phase");
  if (!["started", "completed", "blocked", "unknown"].includes(phase)) throw new Error(`Invalid managed operation phase: ${phase}`);
  validateManagedId(nonempty(value.operationId, "operation.operationId"), "operation");
  if (!["ensure_wip", "insert_change", "checkpoint_change"].includes(nonempty(value.kind, "operation.kind"))) {
    throw new Error(`Invalid managed operation kind: ${String(value.kind)}`);
  }
  nonempty(value.idempotencyKey, "operation.idempotencyKey");
  nonempty(value.startedAt, "operation.startedAt");
  nonempty(value.beforeJjOperationId, "operation.beforeJjOperationId");
  const completedFields = ["completedAt", "afterJjOperationId", "receipt"] as const;
  const blockedFields = ["blockedAt", "blocker"] as const;
  const unknownFields = ["stoppedAt", "reason"] as const;
  if (phase === "started") forbid(value, [...completedFields, ...blockedFields, ...unknownFields], "started operation");
  if (phase === "completed") forbid(value, [...blockedFields, ...unknownFields], "completed operation");
  if (phase === "blocked") forbid(value, [...completedFields, ...unknownFields], "blocked operation");
  if (phase === "unknown") forbid(value, [...completedFields, ...blockedFields], "unknown operation");
  if (phase === "completed") {
    nonempty(value.completedAt, "operation.completedAt");
    nonempty(value.afterJjOperationId, "operation.afterJjOperationId");
    if (value.receipt === undefined) throw new Error("Completed operation requires a receipt.");
  }
  if (phase === "blocked") {
    nonempty(value.blockedAt, "operation.blockedAt");
    if (value.blocker === undefined) throw new Error("Blocked operation requires a blocker.");
  }
  if (phase === "unknown") {
    nonempty(value.stoppedAt, "operation.stoppedAt");
    nonempty(value.reason, "operation.reason");
  }
}

function forbid(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const present = fields.filter((field) => value[field] !== undefined);
  if (present.length) throw new Error(`${label} contains fields from another phase: ${present.join(", ")}`);
}
function validateManagedId(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error(`Invalid ${label} ID: ${value}`);
}
function fullChangeId(value: string): void {
  if (!/^[a-z]{32}$/.test(value)) throw new Error(`Invalid full JJ Change ID: ${value}`);
}
function repositoryPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Invalid repository-relative path: ${value}`);
  }
  if (normalized !== value) throw new Error(`Repository path is not canonical: ${value}`);
  return normalized;
}
function absolute(value: string, label: string): void {
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute.`);
}
function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string.`);
  return value;
}
function record(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function serialize(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
