import type { MergeSummary, WorkspaceId } from "./domain.ts";
export type CustodyDisposition =
  | "attached"
  | "detached"
  | "merged"
  | "abandoned"
  | "missing"
  | "incident";
export type CustodyCause =
  | "create"
  | "attach_proved"
  | "forget"
  | "merge_proved"
  | "merge_conflicts_retained"
  | "abandon_receipted"
  | "evidence_missing"
  | "ambiguity"
  | "incident_resolved"
  | "import"
  | "adopt"
  | "repo_rebound"
  | "heads_refreshed";
export interface CustodyRecord {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly path: string;
  readonly repoId: string;
  readonly repoRoot: string;
  readonly disposition: CustodyDisposition;
  readonly attachmentEvidence: "present" | "absent" | "unknown";
  readonly directoryEvidence: "present" | "absent" | "unknown";
  readonly evidenceAt?: string;
  readonly baseChangeIds: readonly string[];
  readonly rootChangeId?: string;
  readonly headChangeIds: readonly string[];
  readonly mergedIntoChangeId?: string;
  readonly mergedProofOp?: string;
  readonly conflictRetained: boolean;
  readonly ownerId?: string;
  readonly ownerDisplayId?: string;
  readonly anchorToken?: string;
  readonly rootSessionId: string;
  readonly parent?: WorkspaceId;
  readonly pendingOpId?: string;
  readonly quarantined: boolean;
  readonly attention: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly incident?: { stage: string; reason: string };
  readonly merge?: MergeSummary;
}
export interface BeginOperationInput {
  opId: string;
  workspaceId?: string;
  repoId?: string;
  kind: string;
  requestedBy: string;
  pid: number;
  processIdentity: string;
  changeIds?: readonly string[];
  now: string;
}
export interface CustodyOperation extends BeginOperationInput {
  state: "intent" | "jj_applied" | "committed" | "failed" | "unknown";
}
export interface CustodyMutation {
  workspaceId: string;
  ownRootSessionId: string;
  cause: CustodyCause;
  disposition?: CustodyDisposition;
  patch?: Partial<CustodyRecord>;
  now: string;
}
export interface RepositoryIdentity {
  readonly repoId: string;
  readonly fingerprint: string;
  readonly rootsTruncated: boolean;
  readonly storeKey?: string;
  readonly lastKnownRoot: string;
  readonly identityProven: boolean;
  readonly firstSeenAt: string;
  readonly lastVerifiedAt: string;
}
export interface RepositoryEvidence {
  readonly roots: readonly string[];
  readonly rootsTruncated: boolean;
  readonly storeKey?: string;
  readonly canonicalRoot: string;
  readonly now: string;
}
export interface WorkspaceCustodyPort {
  establishRepository(evidence: RepositoryEvidence): Promise<RepositoryIdentity>;
  insert(input: CustodyRecord, operation: BeginOperationInput): Promise<CustodyRecord>;
  list(filter?: {
    rootSessionId?: string;
    repoId?: string;
    dispositions?: readonly CustodyDisposition[];
  }): Promise<CustodyRecord[]>;
  get(id: WorkspaceId): Promise<CustodyRecord | undefined>;
  begin(input: BeginOperationInput): Promise<CustodyOperation>;
  commit(opId: string, mutation: CustodyMutation): Promise<CustodyRecord>;
  fail(opId: string, evidence: string): Promise<void>;
  recordAbandonReceipt(
    opId: string,
    receipt: {
      receiptId: string;
      workspaceId: string;
      requestedBy: "user" | "model_tool" | "scaffold_reclaim";
      changeIds: readonly string[];
      jjOpBefore: string;
      jjOpAfter: string;
      /** True only after JJ proved every canonical head absent. */
      verifiedAbsent: boolean;
      at: string;
    },
  ): Promise<void>;
  openOperations(filter?: { repoId?: string }): Promise<CustodyOperation[]>;
  heartbeat(opId: string): Promise<void>;
}
