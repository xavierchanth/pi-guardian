import { isAbsolute } from "node:path";
import {
  childContextId,
  fileSetClaimId,
  integrationId,
  jjOperationId,
  sourceWorkspaceId,
  workspaceId,
  workspaceWriteLeaseId,
  type ChildContextId,
  type FileSetClaimId,
  type IntegrationId,
  type JjOperationId,
  type SourceWorkspaceId,
  type WorkspaceId,
  type WorkspaceWriteLeaseId,
} from "../concurrency/ids.ts";

export {
  childContextId,
  fileSetClaimId,
  integrationId,
  jjOperationId,
  sourceWorkspaceId,
  workspaceId,
  workspaceWriteLeaseId,
};
export type {
  ChildContextId,
  FileSetClaimId,
  IntegrationId,
  JjOperationId,
  SourceWorkspaceId,
  WorkspaceId,
  WorkspaceWriteLeaseId,
};

declare const semanticIdBrand: unique symbol;
declare const handleBrand: unique symbol;

type Branded<Value, Name extends string> = Value & { readonly [semanticIdBrand]: Name };

export type AbsolutePath = Branded<string, "AbsolutePath">;
export type ChangeId = Branded<string, "ChangeId">;
export type WorkspaceName = Branded<string, "WorkspaceName">;
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
