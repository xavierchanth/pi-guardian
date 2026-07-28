import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { HostConcurrencyState } from "../concurrency/host-state.ts";
import type { PersistedFileSetClaimV1, PersistedSharedTargetV1 } from "./persistence.ts";

export interface PersistedWorkspaceAllocationV1 {
  readonly allocationId: string;
  readonly operationId: string;
  readonly rootSessionId: string;
  readonly ownerContextId: string;
  readonly sourceId: string;
  /** Legacy wire compatibility only; validation strips these observations. */
  readonly sourceWipChangeId?: string;
  readonly baseChangeId?: string;
  readonly sourcePatchHash?: string;
  readonly name: string;
  readonly path: string;
  readonly startedAt: string;
  readonly beforeJjOperationId: string;
}

export interface PersistedWorkspaceIdentityV1 {
  readonly workspaceId: string;
  readonly rootSessionId: string;
  readonly sourceId: string;
  /** Legacy wire compatibility only; validation strips these observations. */
  readonly sourceWipChangeId?: string;
  readonly baseChangeId?: string;
  readonly name: string;
  readonly path: string;
  readonly rootChangeId: string;
  readonly expectedHeadChangeId: string;
}

export type PersistedWorkspaceWriterV1 =
  | { readonly phase: "available"; readonly headChangeId: string; readonly generation: number }
  | { readonly phase: "leased"; readonly ownerContextId: string; readonly leaseId: string; readonly headChangeId: string; readonly generation: number; readonly acquiredAt: string }
  | { readonly phase: "checkpointing"; readonly ownerContextId: string; readonly leaseId: string; readonly expectedHeadChangeId: string; readonly generation: number; readonly operationId: string; readonly startedAt: string }
  | { readonly phase: "rebasing"; readonly ownerContextId: string; readonly expectedHeadChangeId: string; readonly generation: number; readonly operationId: string; readonly startedAt: string }
  | { readonly phase: "interrupted"; readonly priorPhase: "leased" | "checkpointing" | "rebasing"; readonly priorOwnerContextId: string; readonly expectedHeadChangeId: string; readonly generation: number; readonly interruptedAt: string; readonly reason: string };

export interface PersistedWorkspaceOperationV1 {
  readonly operationId: string;
  readonly kind: "allocate_workspace" | "workspace_checkpoint" | "workspace_file_checkpoint" | "rebase_workspace" | "normalize_change_range" | "prepare_workspace_report";
  readonly idempotencyKey: string;
  readonly startedAt: string;
  readonly beforeJjOperationId: string;
  readonly intent: unknown;
  readonly outcome:
    | { readonly phase: "started"; readonly boundary: "prepared" | "mutating" | "verifying" }
    | { readonly phase: "completed"; readonly completedAt: string; readonly afterJjOperationId: string; readonly receipt: unknown }
    | { readonly phase: "blocked"; readonly stoppedAt: string; readonly blocker: unknown }
    | { readonly phase: "unknown"; readonly stoppedAt: string; readonly reason: string };
}

export interface PersistedWorkspaceArtifactRefV1 { readonly digest: string; readonly bytes: number; readonly mediaType: "application/json" | "text/x-diff"; readonly purpose: string; readonly path: string }
type PersistedRangeEvidenceV1 =
  | { readonly evidence: "inline"; readonly orderedChangeIds: readonly string[]; readonly conflictPaths?: readonly string[] }
  | { readonly evidence: "artifact"; readonly artifact: PersistedWorkspaceArtifactRefV1; readonly changeCount: number; readonly conflictCount: number };
export type PersistedWorkspaceReportV1 =
  | ({ readonly range: "empty"; readonly proofHash: string } & PersistedRangeEvidenceV1)
  | ({ readonly range: "nonempty"; readonly contentTipChangeId: string; readonly normalizedPatchHash: string } & PersistedRangeEvidenceV1);

interface PersistedFrozenCustodyV1 { readonly reviewCycle?: number; readonly priorReviewIds?: readonly string[]; readonly identity: PersistedWorkspaceIdentityV1; readonly reportOperationId: string; readonly reportVersion: number; readonly report: PersistedWorkspaceReportV1; readonly operations: readonly PersistedWorkspaceOperationV1[]; readonly createdAt: string; readonly updatedAt: string }
export type PersistedIntegrationAttemptV1 = { readonly integrationId: string; readonly approvalId: string; readonly operationId: string; readonly phase: "prepared" | "workspace_detached" | "empties_removed" | "range_inserted" | "graph_verified" | "directory_removed" | "unknown"; readonly sourcePatchHash: string; readonly orderedChangeIds: readonly string[]; readonly emptyChangeIds: readonly string[]; readonly startedAt: string; readonly lastEvidence: unknown };
export type PersistedIsolatedWorkspaceV1 =
  | ({ readonly version: 1; readonly phase: "allocating"; readonly workspaceId: string; readonly allocation: PersistedWorkspaceAllocationV1; readonly createdAt: string; readonly updatedAt: string })
  | ({ readonly version: 1; readonly phase: "active"; readonly identity: PersistedWorkspaceIdentityV1; readonly writer: PersistedWorkspaceWriterV1; readonly targets: readonly PersistedSharedTargetV1[]; readonly claims: readonly PersistedFileSetClaimV1[]; readonly operations: readonly PersistedWorkspaceOperationV1[]; readonly reviewCycle?: number; readonly priorReviewIds?: readonly string[]; readonly createdAt: string; readonly updatedAt: string })
  | ({ readonly version: 1; readonly phase: "reported"; readonly reportVersion?: number; readonly reviewCycle?: number; readonly priorReviewIds?: readonly string[] } & Omit<PersistedFrozenCustodyV1, "reportVersion">)
  | ({ readonly version: 1; readonly phase: "acknowledged"; readonly implementationEventId: string; readonly taskId: string } & PersistedFrozenCustodyV1)
  | ({ readonly version: 1; readonly phase: "reviewing"; readonly implementationEventId: string; readonly taskId: string; readonly reviewId: string; readonly reviewCycle: number } & PersistedFrozenCustodyV1)
  | ({ readonly version: 1; readonly phase: "changes_requested"; readonly implementationEventId: string; readonly taskId: string; readonly reviewId: string; readonly reviewCycle: number } & PersistedFrozenCustodyV1)
  | ({ readonly version: 1; readonly phase: "approved"; readonly implementationEventId: string; readonly taskId: string; readonly reviewId: string; readonly approval: unknown } & PersistedFrozenCustodyV1)
  | ({ readonly version: 1; readonly phase: "integrating"; readonly implementationEventId: string; readonly taskId: string; readonly reviewId: string; readonly approval: unknown; readonly attempt: PersistedIntegrationAttemptV1 } & PersistedFrozenCustodyV1)
  | ({ readonly version: 1; readonly phase: "conflict_resolution"; readonly implementationEventId: string; readonly taskId: string; readonly reviewId: string; readonly approval: unknown; readonly integrationReceipt: unknown; readonly conflictPaths: readonly string[]; readonly focusedReviewId?: string } & PersistedFrozenCustodyV1)
  | ({ readonly version: 1; readonly phase: "integrated"; readonly taskId: string; readonly approval: unknown; readonly integrationReceipt: unknown } & PersistedFrozenCustodyV1)
  | ({ readonly version: 1; readonly phase: "verifying"; readonly taskId: string; readonly integrationReceipt: unknown; readonly verificationId: string; readonly verificationReceipt: unknown } & PersistedFrozenCustodyV1)
  | ({ readonly version: 1; readonly phase: "closed"; readonly taskId: string; readonly integrationReceipt: unknown; readonly verificationReceipt: unknown; readonly closedAt: string } & PersistedFrozenCustodyV1)
  | ({ readonly version: 1; readonly phase: "closed_no_changes"; readonly identity: PersistedWorkspaceIdentityV1; readonly proof: PersistedWorkspaceReportV1; readonly taskId: string; readonly closedAt: string; readonly createdAt: string; readonly updatedAt: string })
  | ({ readonly version: 1; readonly phase: "cleanup_pending"; readonly identity: PersistedWorkspaceIdentityV1; readonly outcome: "closed" | "closed_no_changes"; readonly semanticReceipt: unknown; readonly reason: string; readonly createdAt: string; readonly updatedAt: string })
  | ({ readonly version: 1; readonly phase: "incident"; readonly workspaceId: string; readonly identity?: PersistedWorkspaceIdentityV1; readonly lastSafePhase: string; readonly reason: string; readonly evidence: unknown; readonly stoppedAt: string; readonly createdAt: string; readonly updatedAt: string });

export interface IsolatedWorkspaceStore {
  create(record: PersistedIsolatedWorkspaceV1): Promise<void>;
  get(workspaceId: string): Promise<PersistedIsolatedWorkspaceV1 | undefined>;
  list(): Promise<PersistedIsolatedWorkspaceV1[]>;
  update(workspaceId: string, reducer: (record: PersistedIsolatedWorkspaceV1) => PersistedIsolatedWorkspaceV1): Promise<PersistedIsolatedWorkspaceV1>;
  interruptLiveWriters(workspaceId: string, reason: string, at?: string): Promise<PersistedIsolatedWorkspaceV1>;
  interruptLiveClaims(workspaceId: string, reason: string, at?: string): Promise<PersistedIsolatedWorkspaceV1>;
}

export class HostIsolatedWorkspaceStore implements IsolatedWorkspaceStore {
  private readonly state: HostConcurrencyState;
  constructor(state: HostConcurrencyState) { this.state = state; }
  async create(record: PersistedIsolatedWorkspaceV1): Promise<void> {
    const value = validateIsolatedWorkspace(record); const id = workspaceIdOf(value);
    await this.state.mutateSegment<PersistedIsolatedWorkspaceV1>("workspaces", "workspace.created", { workspaceId: id }, (records) => {
      if (records.some((candidate) => workspaceIdOf(candidate) === id)) throw new Error(`Workspace already exists: ${id}`);
      return [...records, value];
    });
  }
  async get(workspaceId: string): Promise<PersistedIsolatedWorkspaceV1 | undefined> { return (await this.list()).find((record) => workspaceIdOf(record) === workspaceId); }
  async list(): Promise<PersistedIsolatedWorkspaceV1[]> { return (await this.state.readSegment<PersistedIsolatedWorkspaceV1>("workspaces")).map(validateIsolatedWorkspace); }
  async update(workspaceId: string, reducer: (record: PersistedIsolatedWorkspaceV1) => PersistedIsolatedWorkspaceV1): Promise<PersistedIsolatedWorkspaceV1> {
    let output: PersistedIsolatedWorkspaceV1 | undefined;
    await this.state.mutateSegment<PersistedIsolatedWorkspaceV1>("workspaces", "workspace.replaced", { workspaceId }, (records) => records.map((record) => {
      if (workspaceIdOf(record) !== workspaceId) return record;
      const next = validateIsolatedWorkspace(reducer(structuredClone(record))); if (workspaceIdOf(next) !== workspaceId) throw new Error("Workspace update changed identity."); output = next; return next;
    }));
    if (!output) throw new Error(`Unknown isolated workspace: ${workspaceId}`); return output;
  }
  interruptLiveWriters(workspaceId: string, reason: string, at = new Date().toISOString()): Promise<PersistedIsolatedWorkspaceV1> {
    return this.update(workspaceId, (record) => {
      if (record.phase !== "active" || record.writer.phase === "available" || record.writer.phase === "interrupted") return record;
      const writer = record.writer;
      return { ...record, writer: { phase: "interrupted", priorPhase: writer.phase, priorOwnerContextId: writer.ownerContextId, expectedHeadChangeId: writer.phase === "leased" ? writer.headChangeId : writer.expectedHeadChangeId, generation: writer.generation, interruptedAt: at, reason }, updatedAt: at };
    });
  }
  interruptLiveClaims(workspaceId: string, reason: string, at = new Date().toISOString()): Promise<PersistedIsolatedWorkspaceV1> {
    return this.update(workspaceId, (record) => record.phase !== "active" ? record : { ...record, claims: interruptClaims(record.claims, reason, at), updatedAt: at });
  }
}

export class FileIsolatedWorkspaceStore implements IsolatedWorkspaceStore {
  readonly root: string;
  private readonly updates = new Map<string, Promise<void>>();
  constructor(root: string) { this.root = resolve(root); }

  async create(record: PersistedIsolatedWorkspaceV1): Promise<void> {
    const value = validateIsolatedWorkspace(record);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeFile(this.path(workspaceIdOf(value)), serialize(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  async get(workspaceId: string): Promise<PersistedIsolatedWorkspaceV1 | undefined> {
    try { return validateIsolatedWorkspace(JSON.parse(await readFile(this.path(workspaceId), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async list(): Promise<PersistedIsolatedWorkspaceV1[]> {
    try {
      const output: PersistedIsolatedWorkspaceV1[] = [];
      for (const name of (await readdir(this.root)).filter((item) => item.endsWith(".json")).sort()) {
        const value = await this.get(name.slice(0, -5)); if (value) output.push(value);
      }
      return output;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  update(workspaceId: string, reducer: (record: PersistedIsolatedWorkspaceV1) => PersistedIsolatedWorkspaceV1): Promise<PersistedIsolatedWorkspaceV1> {
    managedId(workspaceId, "workspace");
    const prior = (this.updates.get(workspaceId) ?? Promise.resolve()).catch(() => undefined);
    let release!: () => void;
    const current = new Promise<void>((done) => { release = done; });
    const chain = prior.then(() => current); this.updates.set(workspaceId, chain);
    return prior.then(async () => {
      const existing = await this.get(workspaceId); if (!existing) throw new Error(`Unknown isolated workspace: ${workspaceId}`);
      const next = validateIsolatedWorkspace(reducer(structuredClone(existing)));
      if (workspaceIdOf(next) !== workspaceId) throw new Error("Workspace update cannot change identity.");
      const temporary = `${this.path(workspaceId)}.${randomUUID()}.tmp`;
      await writeFile(temporary, serialize(next), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.path(workspaceId)); return next;
    }).finally(() => { release(); if (this.updates.get(workspaceId) === chain) this.updates.delete(workspaceId); });
  }
  interruptLiveWriters(workspaceId: string, reason: string, at = new Date().toISOString()): Promise<PersistedIsolatedWorkspaceV1> {
    nonempty(reason, "interruption reason");
    return this.update(workspaceId, (record) => {
      if (record.phase !== "active" || record.writer.phase === "available" || record.writer.phase === "interrupted") return record;
      const writer = record.writer;
      return { ...record, writer: { phase: "interrupted", priorPhase: writer.phase, priorOwnerContextId: writer.ownerContextId, expectedHeadChangeId: writer.phase === "leased" ? writer.headChangeId : writer.expectedHeadChangeId, generation: writer.generation, interruptedAt: at, reason }, updatedAt: at };
    });
  }
  interruptLiveClaims(workspaceId: string, reason: string, at = new Date().toISOString()): Promise<PersistedIsolatedWorkspaceV1> {
    nonempty(reason, "interruption reason");
    return this.update(workspaceId, (record) => record.phase !== "active" ? record : { ...record, claims: interruptClaims(record.claims, reason, at), updatedAt: at });
  }
  private path(workspaceId: string): string { managedId(workspaceId, "workspace"); return join(this.root, `${workspaceId}.json`); }
}

export function validateIsolatedWorkspace(input: unknown): PersistedIsolatedWorkspaceV1 {
  if (!object(input) || input.version !== 1) throw new Error("Isolated workspace record must use version 1.");
  const phase = nonempty(input.phase, "phase");
  const phases = ["allocating", "active", "reported", "acknowledged", "reviewing", "changes_requested", "approved", "integrating", "conflict_resolution", "integrated", "verifying", "closed", "closed_no_changes", "cleanup_pending", "incident"];
  if (!phases.includes(phase)) throw new Error(`Invalid workspace phase: ${phase}`);
  nonempty(input.createdAt, "createdAt"); nonempty(input.updatedAt, "updatedAt");
  if (phase === "allocating") { managedId(nonempty(input.workspaceId, "workspaceId"), "workspace"); validateAllocation(input.allocation); forbid(input, ["identity", "writer", "operations", "report"], phase); }
  if (phase === "active") { if (input.targets === undefined) input.targets = []; if (input.claims === undefined) input.claims = []; validateIdentity(input.identity); validateWriter(input.writer, (input.identity as any).expectedHeadChangeId); validateTargets(input.targets, (input.identity as any).expectedHeadChangeId); validateClaims(input.claims, input.targets); validateOperations(input.operations); forbid(input, ["workspaceId", "allocation", "report", "reportOperationId", "reason", "evidence"], phase); }
  const frozen = ["reported", "acknowledged", "reviewing", "changes_requested", "approved", "integrating", "conflict_resolution", "integrated", "verifying", "closed"];
  if (frozen.includes(phase)) { validateIdentity(input.identity); validateOperations(input.operations); managedId(nonempty(input.reportOperationId, "reportOperationId"), "operation"); if (phase !== "reported" && (!Number.isSafeInteger(input.reportVersion) || input.reportVersion < 1)) throw new Error("Frozen custody requires a positive report version."); validateReport(input.report, input.identity.rootChangeId, input.identity.expectedHeadChangeId); if (phase !== "reported") managedId(nonempty(input.taskId, "taskId"), "task"); if (["acknowledged", "reviewing", "changes_requested", "approved", "integrating", "conflict_resolution"].includes(phase)) managedId(nonempty(input.implementationEventId, "implementationEventId"), "event"); if (["reviewing", "changes_requested", "approved", "integrating", "conflict_resolution"].includes(phase)) managedId(nonempty(input.reviewId, "reviewId"), "review"); if (phase === "reviewing" || phase === "changes_requested") { if (!Number.isSafeInteger(input.reviewCycle) || input.reviewCycle < 0) throw new Error("Review cycle is invalid."); } if (phase === "approved" || phase === "integrating" || phase === "conflict_resolution") { if (input.approval === undefined) throw new Error(`${phase} requires approval evidence.`); } if (phase === "integrating") validateIntegrationAttempt(input.attempt); if ((phase === "integrated" || phase === "verifying" || phase === "closed") && input.integrationReceipt === undefined) throw new Error(`${phase} requires integration receipt.`); if ((phase === "verifying" || phase === "closed") && input.verificationReceipt === undefined) throw new Error("Closed custody requires verification receipt."); forbid(input, ["workspaceId", "allocation", "writer", "reason", "evidence"], phase); }
  if (phase === "closed_no_changes") { validateIdentity(input.identity); managedId(nonempty(input.taskId, "taskId"), "task"); validateReport(input.proof, input.identity.rootChangeId, input.identity.expectedHeadChangeId); if (input.proof.range !== "empty") throw new Error("closed_no_changes requires empty proof."); nonempty(input.closedAt, "closedAt"); }
  if (phase === "cleanup_pending") { validateIdentity(input.identity); if (!["closed", "closed_no_changes"].includes(String(input.outcome)) || input.semanticReceipt === undefined) throw new Error("Cleanup pending requires semantic outcome receipt."); nonempty(input.reason, "reason"); }
  if (phase === "incident") { managedId(nonempty(input.workspaceId, "workspaceId"), "workspace"); if (input.identity !== undefined) validateIdentity(input.identity); nonempty(input.lastSafePhase, "lastSafePhase"); nonempty(input.reason, "reason"); nonempty(input.stoppedAt, "stoppedAt"); if (input.evidence === undefined) throw new Error("Incident evidence is required."); forbid(input, ["allocation", "writer", "operations", "report"], phase); }
  return input as unknown as PersistedIsolatedWorkspaceV1;
}

function validateAllocation(value: unknown): void { if (!object(value)) throw new Error("Workspace allocation is required."); for (const key of ["allocationId", "operationId", "rootSessionId", "ownerContextId", "sourceId"] as const) managedId(nonempty(value[key], key), key); for (const key of ["sourceWipChangeId", "baseChangeId"] as const) if (value[key] !== undefined) { fullChangeId(nonempty(value[key], key)); delete value[key]; } if (value.sourcePatchHash !== undefined) { digest(nonempty(value.sourcePatchHash, "sourcePatchHash")); delete value.sourcePatchHash; } workspaceName(nonempty(value.name, "name")); absolute(nonempty(value.path, "path")); nonempty(value.startedAt, "startedAt"); nonempty(value.beforeJjOperationId, "beforeJjOperationId"); }
function validateIdentity(value: unknown): asserts value is PersistedWorkspaceIdentityV1 { if (!object(value)) throw new Error("Workspace identity is required."); for (const key of ["workspaceId", "rootSessionId", "sourceId"] as const) managedId(nonempty(value[key], key), key); for (const key of ["rootChangeId", "expectedHeadChangeId"] as const) fullChangeId(nonempty(value[key], key)); for (const key of ["sourceWipChangeId", "baseChangeId"] as const) if (value[key] !== undefined) { fullChangeId(nonempty(value[key], key)); delete value[key]; } workspaceName(nonempty(value.name, "name")); absolute(nonempty(value.path, "path")); }
function validateWriter(value: unknown, expectedHead: string): void { if (!object(value)) throw new Error("Active workspace requires writer state."); const phase = nonempty(value.phase, "writer.phase"); if (!["available", "leased", "checkpointing", "rebasing", "interrupted"].includes(phase)) throw new Error(`Invalid writer phase: ${phase}`); if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0) throw new Error("Writer generation must be a nonnegative integer."); const head = phase === "available" || phase === "leased" ? value.headChangeId : value.expectedHeadChangeId; fullChangeId(nonempty(head, "writer head")); if (head !== expectedHead) throw new Error("Writer head must equal workspace expected head."); if (phase === "leased" || phase === "checkpointing") managedId(nonempty(value.leaseId, "writer.leaseId"), "lease"); if (phase !== "available") managedId(nonempty(phase === "interrupted" ? value.priorOwnerContextId : value.ownerContextId, "writer owner"), "owner context"); if (phase === "checkpointing" || phase === "rebasing") managedId(nonempty(value.operationId, "writer.operationId"), "operation"); if (phase === "interrupted") { if (!["leased", "checkpointing", "rebasing"].includes(String(value.priorPhase))) throw new Error("Interrupted writer prior phase is invalid."); nonempty(value.interruptedAt, "writer.interruptedAt"); nonempty(value.reason, "writer.reason"); } }
function validateTargets(value: unknown, wipChangeId: string): void { if (!Array.isArray(value)) throw new Error("Active workspace targets must be an array."); const ids = new Set<string>(); for (const target of value) { if (!object(target)) throw new Error("Workspace target is invalid."); fullChangeId(nonempty(target.changeId, "target.changeId")); if (ids.has(target.changeId)) throw new Error("Duplicate workspace target Change ID."); ids.add(target.changeId); if (target.wipChangeId !== wipChangeId) throw new Error("Workspace target must bind the stable workspace WIP."); managedId(nonempty(target.ownerContextId, "target.ownerContextId"), "target owner"); nonempty(target.description, "target.description"); managedId(nonempty(target.insertOperationId, "target.insertOperationId"), "operation"); nonempty(target.createdAt, "target.createdAt"); } }
function validateClaims(value: unknown, targets: unknown): void { if (!Array.isArray(value) || !Array.isArray(targets)) throw new Error("Active workspace claims must be an array."); const targetIds = new Set(targets.filter(object).map((target) => target.changeId)); const ids = new Set<string>(); for (const claim of value) { if (!object(claim)) throw new Error("Workspace claim is invalid."); const id = nonempty(claim.claimId, "claim.claimId"); managedId(id, "claim"); if (ids.has(id)) throw new Error("Duplicate workspace claim ID."); ids.add(id); if (!targetIds.has(claim.targetChangeId)) throw new Error("Workspace claim target is not assigned in this workspace."); if (!Array.isArray(claim.paths) || !claim.paths.length) throw new Error("Workspace claim requires paths."); const phase = nonempty(claim.phase, "claim.phase"); if (!["queued", "active", "checkpointing", "released", "interrupted", "breached"].includes(phase)) throw new Error("Invalid workspace claim phase."); } }
function validateOperations(value: unknown): void { if (!Array.isArray(value)) throw new Error("Workspace operations must be an array."); const ids = new Set<string>(); for (const item of value) { if (!object(item) || !object(item.outcome)) throw new Error("Workspace operation is invalid."); const id = nonempty(item.operationId, "operationId"); managedId(id, "operation"); if (ids.has(id)) throw new Error(`Duplicate workspace operation: ${id}`); ids.add(id); if (!["allocate_workspace", "workspace_checkpoint", "workspace_file_checkpoint", "rebase_workspace", "normalize_change_range", "prepare_workspace_report"].includes(nonempty(item.kind, "operation.kind"))) throw new Error("Invalid workspace operation kind."); nonempty(item.idempotencyKey, "operation.idempotencyKey"); nonempty(item.startedAt, "operation.startedAt"); nonempty(item.beforeJjOperationId, "operation.beforeJjOperationId"); if (item.intent === undefined) throw new Error("Workspace operation intent is required."); const phase = nonempty(item.outcome.phase, "operation.outcome.phase"); if (!["started", "completed", "blocked", "unknown"].includes(phase)) throw new Error("Invalid workspace operation outcome."); if (phase === "started" && !["prepared", "mutating", "verifying"].includes(String(item.outcome.boundary))) throw new Error("Started operation boundary is invalid."); if (phase === "completed" && item.outcome.receipt === undefined) throw new Error("Completed operation requires receipt."); if (phase === "blocked" && item.outcome.blocker === undefined) throw new Error("Blocked operation requires blocker."); if (phase === "unknown") nonempty(item.outcome.reason, "operation outcome reason"); } }
function validateReport(value: unknown, root: string, head: string): void { if (!object(value) || !["empty", "nonempty"].includes(String(value.range)) || !["inline", "artifact"].includes(String(value.evidence))) throw new Error("Workspace report is invalid."); if (value.evidence === "inline") { if (!Array.isArray(value.orderedChangeIds)) throw new Error("Inline report requires ordered changes."); for (const id of value.orderedChangeIds) fullChangeId(nonempty(id, "report change ID")); if (value.orderedChangeIds.includes(head)) throw new Error("Report range must exclude expected empty head."); if (value.range === "nonempty" && value.orderedChangeIds[0] !== root) throw new Error("Report range must begin at tracked root."); } else { validateArtifact(value.artifact); if (!Number.isSafeInteger(value.changeCount) || !Number.isSafeInteger(value.conflictCount)) throw new Error("Artifact report requires bounded counts."); } if (value.range === "empty") digest(nonempty(value.proofHash, "report.proofHash")); else { fullChangeId(nonempty(value.contentTipChangeId, "report.contentTipChangeId")); if (value.evidence === "inline" && value.orderedChangeIds.at(-1) !== value.contentTipChangeId) throw new Error("Report content tip must end ordered range."); digest(nonempty(value.normalizedPatchHash, "report.normalizedPatchHash")); if (value.evidence === "inline" && !Array.isArray(value.conflictPaths)) throw new Error("Nonempty inline report requires conflict paths."); } }
function validateArtifact(value: unknown): void { if (!object(value)) throw new Error("Workspace artifact reference is invalid."); digest(nonempty(value.digest, "artifact.digest")); if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0) throw new Error("Artifact bytes are invalid."); if (!["application/json", "text/x-diff"].includes(String(value.mediaType))) throw new Error("Artifact media type is invalid."); nonempty(value.purpose, "artifact.purpose"); absolute(nonempty(value.path, "artifact.path")); }
function validateIntegrationAttempt(value: unknown): void { if (!object(value)) throw new Error("Integration attempt is required."); for (const key of ["integrationId", "approvalId", "operationId"] as const) managedId(nonempty(value[key], key), key); if (!["prepared", "workspace_detached", "empties_removed", "range_inserted", "graph_verified", "directory_removed", "unknown"].includes(String(value.phase))) throw new Error("Integration attempt phase is invalid."); digest(nonempty(value.sourcePatchHash, "sourcePatchHash")); if (!Array.isArray(value.orderedChangeIds) || !Array.isArray(value.emptyChangeIds)) throw new Error("Integration range evidence is required."); nonempty(value.startedAt, "integration startedAt"); if (value.lastEvidence === undefined) throw new Error("Integration last evidence is required."); }
function interruptClaims(claims: readonly PersistedFileSetClaimV1[], reason: string, at: string): PersistedFileSetClaimV1[] { return claims.map((claim): PersistedFileSetClaimV1 => { if (claim.phase === "released" || claim.phase === "interrupted" || claim.phase === "breached") return claim; const base = { claimId: claim.claimId, ownerContextId: claim.ownerContextId, rootSessionId: claim.rootSessionId, targetChangeId: claim.targetChangeId, wipChangeId: claim.wipChangeId, paths: claim.paths, queuedAt: claim.queuedAt }; return { ...base, phase: "interrupted", priorPhase: claim.phase, reason, interruptedAt: at, ...((claim.phase === "active" || claim.phase === "checkpointing") ? { recovery: { fingerprints: claim.fingerprints, baselinePatchHash: claim.baselinePatchHash, mutatedPaths: claim.mutatedPaths, ...(claim.phase === "checkpointing" ? { operationId: claim.operationId } : {}) } } : {}) }; }); }
function workspaceIdOf(record: PersistedIsolatedWorkspaceV1): string { if (record.phase === "allocating" || record.phase === "incident") return record.workspaceId; return record.identity.workspaceId; }
function object(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function nonempty(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string.`); return value; }
function managedId(value: string, label: string): void { if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error(`Invalid ${label} ID: ${value}`); }
function fullChangeId(value: string): void { if (!/^[a-z]{32}$/.test(value)) throw new Error(`Invalid full JJ Change ID: ${value}`); }
function digest(value: string): void { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid SHA-256 digest: ${value}`); }
function workspaceName(value: string): void { if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(value)) throw new Error(`Invalid workspace name: ${value}`); }
function absolute(value: string): void { if (!isAbsolute(value)) throw new Error(`Workspace path must be absolute: ${value}`); }
function forbid(value: Record<string, any>, fields: readonly string[], phase: string): void { const found = fields.filter((field) => value[field] !== undefined); if (found.length) throw new Error(`${phase} workspace contains fields from another phase: ${found.join(", ")}`); }
function serialize(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
