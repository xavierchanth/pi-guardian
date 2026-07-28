import type {
  ApprovedWorkspaceIntegration,
  ChangeDescription,
  ChangeId,
  CheckpointableFileSetClaim,
  ChildContextId,
  FrozenWorkspaceHandle,
  IsolatedWorkspaceWriteLease,
  JjOperationId,
  WorkspaceRebaseLease,
  SourceWorkspaceHandle,
  WorkspaceId,
  WorkspaceName,
} from "./domain.ts";

export type JjOperationBlocker =
  | { kind: "decision_required"; reason: string }
  | { kind: "immutable"; changeId: ChangeId }
  | { kind: "identity_mismatch"; expected: ChangeId; observed: readonly ChangeId[] }
  | { kind: "divergent"; changeId: ChangeId }
  | { kind: "foreign_work"; reason: string }
  | { kind: "conflicted"; changeIds: readonly ChangeId[]; paths: readonly string[] }
  | { kind: "unknown_partial_mutation"; operationId: JjOperationId; phase: string };

export type JjOperationResult<Receipt> =
  | { kind: "completed"; receipt: Receipt }
  | { kind: "blocked"; blocker: JjOperationBlocker };

export interface JjStatus {
  readonly sourceChangeId: ChangeId;
  readonly operationId: JjOperationId;
  readonly description: string;
  readonly empty: boolean;
  readonly conflicted: boolean;
  readonly immutable: boolean;
  readonly parentChangeIds: readonly ChangeId[];
  readonly trackedWipChangeId?: ChangeId;
  readonly privateProtection: "present" | "missing";
}

export interface EnsureWipReceipt {
  readonly wipChangeId: ChangeId;
  readonly operationId: JjOperationId;
  readonly disposition: "existing" | "described_existing" | "created";
  readonly description: ChangeDescription;
  readonly privateProtection: "present" | "missing";
}

export interface InsertChangeReceipt {
  readonly insertedChangeId: ChangeId;
  readonly wipChangeId: ChangeId;
  readonly owner: ChildContextId;
  readonly description: ChangeDescription;
  readonly parentChangeIds: readonly ChangeId[];
  readonly priorWipParentChangeIds: readonly ChangeId[];
  readonly wipParentChangeIds: readonly ChangeId[];
  readonly wipPatchHash: string;
  readonly operationId: JjOperationId;
}

export interface CheckpointChangeReceipt {
  readonly checkpointedChangeId: ChangeId;
  readonly wipChangeId: ChangeId;
  readonly claimId: string;
  readonly changedPaths: readonly string[];
  readonly parentChangeIds: readonly ChangeId[];
  readonly unownedWipPatchHash: string;
  readonly conflicted: boolean;
  readonly operationId: JjOperationId;
}

export interface WorkspaceCheckpointReceipt {
  readonly workspaceId: WorkspaceId;
  readonly checkpointedChangeId: ChangeId;
  readonly previousHeadChangeId: ChangeId;
  readonly newHeadChangeId: ChangeId;
  readonly description: ChangeDescription;
  readonly parentChangeIds: readonly ChangeId[];
  readonly conflicted: boolean;
  readonly operationId: JjOperationId;
}

export type WorkspaceRebaseTarget =
  | { readonly kind: "source_parent" }
  | { readonly kind: "exact_change"; readonly changeId: ChangeId };

interface WorkspaceRebaseReceiptBase {
  readonly workspaceId: WorkspaceId;
  readonly rootChangeId: ChangeId;
  readonly contentTipChangeId: ChangeId;
  readonly workspaceHeadChangeId: ChangeId;
  readonly operationId: JjOperationId;
}

export type WorkspaceRebaseReceipt = WorkspaceRebaseReceiptBase & (
  | { readonly disposition: "range_equivalent"; readonly normalizedPatchHash: string }
  | { readonly disposition: "range_changed"; readonly beforePatchHash: string; readonly afterPatchHash: string }
  | { readonly disposition: "conflicted"; readonly conflictPaths: readonly string[] }
);

export type WorkspacePurpose = "relocation" | "delegation";

export interface CreateWorkspaceReceipt {
  readonly workspaceId: WorkspaceId;
  readonly name: WorkspaceName;
  readonly rootChangeId: ChangeId;
  readonly workspaceHeadChangeId: ChangeId;
  readonly operationId: JjOperationId;
}

interface WorkspaceReportReceiptBase {
  readonly workspaceId: WorkspaceId;
  readonly rootChangeId: ChangeId;
  readonly workspaceHeadChangeId: ChangeId;
  readonly operationId: JjOperationId;
}

export type WorkspaceReportReceipt = WorkspaceReportReceiptBase & (
  | { readonly range: "empty" }
  | { readonly range: "nonempty"; readonly contentTipChangeId: ChangeId }
);

export interface IntegrationReceipt {
  readonly workspaceId: WorkspaceId;
  readonly integratedChangeIds: readonly ChangeId[];
  readonly conflicted: boolean;
  readonly operationId: JjOperationId;
}

export interface JjStatusReader {
  inspectStatus(source: SourceWorkspaceHandle): Promise<JjStatus>;
}

export interface WipEnsurer {
  ensureWip(source: SourceWorkspaceHandle): Promise<JjOperationResult<EnsureWipReceipt>>;
}

export interface ChangeInserter {
  insertChange(
    source: SourceWorkspaceHandle,
    input: Readonly<{ description: ChangeDescription; owner: ChildContextId }>,
  ): Promise<JjOperationResult<InsertChangeReceipt>>;
}

export interface SharedChangeCheckpointer {
  checkpointChange(claim: CheckpointableFileSetClaim): Promise<JjOperationResult<CheckpointChangeReceipt>>;
}

export interface WorkspaceCheckpointer {
  checkpointWorkspace(
    lease: IsolatedWorkspaceWriteLease,
    input: Readonly<{ description: ChangeDescription }>,
  ): Promise<JjOperationResult<WorkspaceCheckpointReceipt>>;
}

export interface WorkspaceCreator {
  createWorkspace(
    source: SourceWorkspaceHandle,
    input: Readonly<{ name: WorkspaceName; purpose: WorkspacePurpose }>,
  ): Promise<JjOperationResult<CreateWorkspaceReceipt>>;
}

export interface WorkspaceRebaser {
  rebaseWorkspace(
    lease: WorkspaceRebaseLease,
    target: WorkspaceRebaseTarget,
  ): Promise<JjOperationResult<WorkspaceRebaseReceipt>>;
}

export interface WorkspaceReporter {
  prepareWorkspaceReport(workspace: FrozenWorkspaceHandle): Promise<JjOperationResult<WorkspaceReportReceipt>>;
}

export interface WorkspaceIntegrator {
  integrateWorkspace(approval: ApprovedWorkspaceIntegration): Promise<JjOperationResult<IntegrationReceipt>>;
}

export interface JjOperations
  extends JjStatusReader,
    WipEnsurer,
    ChangeInserter,
    SharedChangeCheckpointer,
    WorkspaceCheckpointer,
    WorkspaceCreator,
    WorkspaceRebaser,
    WorkspaceReporter,
    WorkspaceIntegrator {}
