import type { ChangeId } from "../jj/domain.ts";
import type {
  ChildContextId,
  ChildEventId,
  ExecutionCycleId,
  FileSetClaimId,
  IntegrationId,
  JjOperationId,
  ReviewId,
  RootSessionId,
  SourceWorkspaceId,
  UsageEventId,
  WorkspaceId,
} from "./ids.ts";

export interface ChildIntent {
  readonly role: string;
  readonly objective: string;
  readonly cwdKind: "source" | "isolated";
}

export type ChildExecution =
  | { phase: "created" }
  | { phase: "starting"; cycleId: ExecutionCycleId; startedAt: string }
  | { phase: "running"; cycleId: ExecutionCycleId; startedAt: string; lastHeartbeatAt: string }
  | { phase: "awaiting_parent"; cycleId: ExecutionCycleId; questionEventId: ChildEventId }
  | { phase: "interrupted"; cycleId: ExecutionCycleId; reason: string; interruptedAt: string }
  | { phase: "completed"; cycleId: ExecutionCycleId; terminalEventId: ChildEventId; completedAt: string }
  | { phase: "cancelled"; cycleId: ExecutionCycleId; terminalEventId: ChildEventId; cancelledAt: string }
  | { phase: "incident"; cycleId?: ExecutionCycleId; reason: string; stoppedAt: string };

export interface ChildContextRecord {
  readonly contextId: ChildContextId;
  readonly rootSessionId: RootSessionId;
  readonly parentContextId?: ChildContextId;
  readonly intent: ChildIntent;
  readonly execution: ChildExecution;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ChildEventAcknowledgement =
  | { phase: "pending"; eventId: ChildEventId; emittedAt: string }
  | { phase: "acknowledged"; eventId: ChildEventId; emittedAt: string; acknowledgedAt: string };

export function acknowledgeChildEvent(
  state: ChildEventAcknowledgement,
  acknowledgedAt: string,
): ChildEventAcknowledgement {
  if (state.phase === "acknowledged") return state;
  return { ...state, phase: "acknowledged", acknowledgedAt };
}

declare const canonicalFileSetBrand: unique symbol;

export interface CanonicalFileSet {
  readonly paths: readonly string[];
  readonly [canonicalFileSetBrand]: true;
}

export function canonicalFileSet(input: readonly string[]): CanonicalFileSet {
  if (input.length === 0) throw new Error("A file-set claim must contain at least one path.");
  const normalized = [...new Set(input.map((path) => {
    const value = path.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!value || value.startsWith("/") || value.split("/").includes("..")) {
      throw new Error(`Invalid repository-relative path: ${path}`);
    }
    return value;
  }))].sort((left, right) => left.localeCompare(right));
  return { paths: normalized } as unknown as CanonicalFileSet;
}

export type FileSetClaim =
  | { phase: "queued"; claimId: FileSetClaimId; owner: ChildContextId; fileSet: CanonicalFileSet; queuedAt: string }
  | { phase: "active"; claimId: FileSetClaimId; owner: ChildContextId; fileSet: CanonicalFileSet; acquiredAt: string }
  | { phase: "checkpointing"; claimId: FileSetClaimId; owner: ChildContextId; fileSet: CanonicalFileSet; operationId: JjOperationId }
  | { phase: "released"; claimId: FileSetClaimId; releasedAt: string; checkpointOperationId?: JjOperationId }
  | { phase: "interrupted"; claimId: FileSetClaimId; priorPhase: "queued" | "active" | "checkpointing"; reason: string }
  | { phase: "breached"; claimId: FileSetClaimId; reason: string; observedAt: string };

export function interruptFileSetClaim(claim: FileSetClaim, reason: string): FileSetClaim {
  if (claim.phase === "released" || claim.phase === "interrupted" || claim.phase === "breached") return claim;
  return { phase: "interrupted", claimId: claim.claimId, priorPhase: claim.phase, reason };
}

export type WorkspaceWriterToken =
  | { phase: "available"; workspaceId: WorkspaceId; headChangeId: ChangeId; lastOperationId?: JjOperationId }
  | { phase: "active"; workspaceId: WorkspaceId; owner: ChildContextId; headChangeId: ChangeId }
  | { phase: "checkpointing"; workspaceId: WorkspaceId; owner: ChildContextId; expectedHeadChangeId: ChangeId; operationId: JjOperationId }
  | { phase: "interrupted"; workspaceId: WorkspaceId; priorOwner: ChildContextId; expectedHeadChangeId: ChangeId };

export function interruptWorkspaceWriter(token: WorkspaceWriterToken): WorkspaceWriterToken {
  if (token.phase === "available" || token.phase === "interrupted") return token;
  return {
    phase: "interrupted",
    workspaceId: token.workspaceId,
    priorOwner: token.owner,
    expectedHeadChangeId: token.phase === "active" ? token.headChangeId : token.expectedHeadChangeId,
  };
}

interface WorkspaceIdentity {
  readonly workspaceId: WorkspaceId;
  readonly sourceWorkspaceId: SourceWorkspaceId;
  readonly path: string;
  readonly rootChangeId: ChangeId;
  readonly workspaceHeadChangeId: ChangeId;
}

type WorkspaceRange =
  | { readonly range: "empty" }
  | { readonly range: "nonempty"; readonly contentTipChangeId: ChangeId };

export type WorkspaceCustody =
  | ({ phase: "allocated" } & WorkspaceIdentity)
  | ({ phase: "active"; owner: ChildContextId } & WorkspaceIdentity)
  | ({ phase: "reported"; reportOperationId: JjOperationId } & WorkspaceIdentity & WorkspaceRange)
  | ({ phase: "reviewed"; reviewId: ReviewId } & WorkspaceIdentity & WorkspaceRange)
  | ({ phase: "integrated"; integrationId: IntegrationId; integratedAt: string } & WorkspaceIdentity)
  | ({ phase: "closed_no_changes"; closedAt: string } & WorkspaceIdentity)
  | ({ phase: "cleanup_pending"; prior: "integrated" | "closed_no_changes"; reason: string } & WorkspaceIdentity)
  | ({ phase: "incident"; reason: string; stoppedAt: string } & WorkspaceIdentity);

export interface IntrinsicUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
}

export interface UsageEvent {
  readonly eventId: UsageEventId;
  readonly contextId: ChildContextId;
  readonly cycleId: ExecutionCycleId;
  readonly provider: string;
  readonly model: string;
  readonly role: string;
  readonly usage: IntrinsicUsage;
}

export type UsageAttribution =
  | { phase: "pending"; event: UsageEvent }
  | { phase: "attributed"; event: UsageEvent; rootSessionId: RootSessionId; attributedAt: string };

export function attributeUsage(
  state: UsageAttribution,
  rootSessionId: RootSessionId,
  attributedAt: string,
): UsageAttribution {
  if (state.phase === "attributed") return state;
  return { phase: "attributed", event: state.event, rootSessionId, attributedAt };
}
