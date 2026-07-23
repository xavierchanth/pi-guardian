import { isAbsolute } from "node:path";

declare const semanticIdBrand: unique symbol;
declare const handleBrand: unique symbol;

type Branded<Value, Name extends string> = Value & { readonly [semanticIdBrand]: Name };

export type AbsolutePath = Branded<string, "AbsolutePath">;
export type ChangeId = Branded<string, "ChangeId">;
export type SourceWorkspaceId = Branded<string, "SourceWorkspaceId">;
export type WorkspaceId = Branded<string, "WorkspaceId">;
export type WorkspaceName = Branded<string, "WorkspaceName">;
export type ChildContextId = Branded<string, "ChildContextId">;
export type FileSetClaimId = Branded<string, "FileSetClaimId">;
export type WorkspaceWriteLeaseId = Branded<string, "WorkspaceWriteLeaseId">;
export type IntegrationId = Branded<string, "IntegrationId">;
export type JjOperationId = Branded<string, "JjOperationId">;
export type ChangeDescription = Branded<string, "ChangeDescription">;

export function absolutePath(value: string): AbsolutePath {
  if (!isAbsolute(value)) throw new Error(`Expected an absolute path: ${value}`);
  return value as AbsolutePath;
}

export function changeId(value: string): ChangeId {
  if (!/^[a-z]{32}$/.test(value)) throw new Error(`Invalid full JJ Change ID: ${value}`);
  return value as ChangeId;
}

export function workspaceName(value: string): WorkspaceName {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(value)) throw new Error(`Invalid JJ workspace name: ${value}`);
  return value as WorkspaceName;
}

export function changeDescription(value: string): ChangeDescription {
  const normalized = value.trim();
  if (!normalized) throw new Error("JJ change description must not be empty.");
  if (Buffer.byteLength(normalized, "utf8") > 4096) throw new Error("JJ change description exceeds 4096 bytes.");
  return normalized as ChangeDescription;
}

export function sourceWorkspaceId(value: string): SourceWorkspaceId { return opaqueId(value, "source workspace") as SourceWorkspaceId; }
export function workspaceId(value: string): WorkspaceId { return opaqueId(value, "workspace") as WorkspaceId; }
export function childContextId(value: string): ChildContextId { return opaqueId(value, "child context") as ChildContextId; }
export function fileSetClaimId(value: string): FileSetClaimId { return opaqueId(value, "file-set claim") as FileSetClaimId; }
export function workspaceWriteLeaseId(value: string): WorkspaceWriteLeaseId { return opaqueId(value, "workspace write lease") as WorkspaceWriteLeaseId; }
export function integrationId(value: string): IntegrationId { return opaqueId(value, "integration") as IntegrationId; }
export function jjOperationId(value: string): JjOperationId { return opaqueId(value, "JJ operation") as JjOperationId; }

function opaqueId(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error(`Invalid ${label} ID: ${value}`);
  return value;
}

export interface SourceWorkspaceHandle {
  readonly kind: "source_workspace";
  readonly sourceId: SourceWorkspaceId;
  readonly [handleBrand]: "SourceWorkspaceHandle";
}

export interface IsolatedWorkspaceWriteLease {
  readonly kind: "isolated_workspace_write_lease";
  readonly workspaceId: WorkspaceId;
  readonly leaseId: WorkspaceWriteLeaseId;
  readonly [handleBrand]: "IsolatedWorkspaceWriteLease";
}

export interface CheckpointableFileSetClaim {
  readonly kind: "checkpointable_file_set_claim";
  readonly claimId: FileSetClaimId;
  readonly [handleBrand]: "CheckpointableFileSetClaim";
}

export interface FrozenWorkspaceHandle {
  readonly kind: "frozen_workspace";
  readonly workspaceId: WorkspaceId;
  readonly [handleBrand]: "FrozenWorkspaceHandle";
}

export interface ApprovedWorkspaceIntegration {
  readonly kind: "approved_workspace_integration";
  readonly integrationId: IntegrationId;
  readonly workspaceId: WorkspaceId;
  readonly [handleBrand]: "ApprovedWorkspaceIntegration";
}

export function sourceWorkspaceHandle(sourceId: SourceWorkspaceId): SourceWorkspaceHandle {
  return { kind: "source_workspace", sourceId } as SourceWorkspaceHandle;
}

export function isolatedWorkspaceWriteLease(
  workspaceId: WorkspaceId,
  leaseId: WorkspaceWriteLeaseId,
): IsolatedWorkspaceWriteLease {
  return { kind: "isolated_workspace_write_lease", workspaceId, leaseId } as IsolatedWorkspaceWriteLease;
}

export function checkpointableFileSetClaim(claimId: FileSetClaimId): CheckpointableFileSetClaim {
  return { kind: "checkpointable_file_set_claim", claimId } as CheckpointableFileSetClaim;
}

export function frozenWorkspaceHandle(workspaceId: WorkspaceId): FrozenWorkspaceHandle {
  return { kind: "frozen_workspace", workspaceId } as FrozenWorkspaceHandle;
}

export function approvedWorkspaceIntegration(
  integrationId: IntegrationId,
  workspaceId: WorkspaceId,
): ApprovedWorkspaceIntegration {
  return { kind: "approved_workspace_integration", integrationId, workspaceId } as ApprovedWorkspaceIntegration;
}
