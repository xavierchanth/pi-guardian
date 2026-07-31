declare const semanticIdBrand: unique symbol;

type SemanticId<Name extends string> = string & { readonly [semanticIdBrand]: Name };

export type RootSessionId = SemanticId<"RootSessionId">;
export type ChildContextId = SemanticId<"ChildContextId">;
export type ExecutionCycleId = SemanticId<"ExecutionCycleId">;
export type ChildEventId = SemanticId<"ChildEventId">;
export type UsageEventId = SemanticId<"UsageEventId">;
export type FileSetClaimId = SemanticId<"FileSetClaimId">;
export type SourceWorkspaceId = SemanticId<"SourceWorkspaceId">;
export type WorkspaceId = SemanticId<"WorkspaceId">;
export type WorkspaceWriteLeaseId = SemanticId<"WorkspaceWriteLeaseId">;
export type JjOperationId = SemanticId<"JjOperationId">;
export type ReviewId = SemanticId<"ReviewId">;
export type IntegrationId = SemanticId<"IntegrationId">;
export type RecoveryAuthorizationId = SemanticId<"RecoveryAuthorizationId">;

export function rootSessionId(value: string): RootSessionId {
  return semanticId(value, "root session") as RootSessionId;
}
export function childContextId(value: string): ChildContextId {
  return semanticId(value, "child context") as ChildContextId;
}
export function executionCycleId(value: string): ExecutionCycleId {
  return semanticId(value, "execution cycle") as ExecutionCycleId;
}
export function childEventId(value: string): ChildEventId {
  return semanticId(value, "child event") as ChildEventId;
}
export function usageEventId(value: string): UsageEventId {
  return semanticId(value, "usage event") as UsageEventId;
}
export function fileSetClaimId(value: string): FileSetClaimId {
  return semanticId(value, "file-set claim") as FileSetClaimId;
}
export function sourceWorkspaceId(value: string): SourceWorkspaceId {
  return semanticId(value, "source workspace") as SourceWorkspaceId;
}
export function workspaceId(value: string): WorkspaceId {
  return semanticId(value, "workspace") as WorkspaceId;
}
export function workspaceWriteLeaseId(value: string): WorkspaceWriteLeaseId {
  return semanticId(value, "workspace write lease") as WorkspaceWriteLeaseId;
}
export function jjOperationId(value: string): JjOperationId {
  return semanticId(value, "JJ operation") as JjOperationId;
}
export function reviewId(value: string): ReviewId {
  return semanticId(value, "review") as ReviewId;
}
export function integrationId(value: string): IntegrationId {
  return semanticId(value, "integration") as IntegrationId;
}
export function recoveryAuthorizationId(value: string): RecoveryAuthorizationId {
  return semanticId(value, "recovery authorization") as RecoveryAuthorizationId;
}

function semanticId(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value))
    throw new Error(`Invalid ${label} ID: ${value}`);
  return value;
}
