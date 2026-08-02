/**
 * Isolation domain: managed JJ workspaces for subagents.
 *
 * The rule that anchors this module: a managed workspace's root commit has the
 * SAME PARENTS as the source working copy `@`. That gives an agent everything the
 * user has already landed while never exposing the user's in-flight `@` content,
 * and it holds whether `@` has one parent or many. When `@` is a single-parent
 * commit the rule degenerates to the historical "branch from `@-`" behaviour.
 *
 * Parents are resolved to concrete change ids at operation time and never stored
 * as revsets, so a later `@` move cannot silently retarget a pending operation.
 */

export type WorkspaceId = string;

/** How a workspace's changes are folded back into the source graph. */
/** MG-0 has one graph operation: always merge the source under the target WC. */
export type MergeStrategy = "merge-under";

export type WorkspacePhase =
  /** Directory and jj workspace exist; an agent may be writing. */
  | "active"
  /** Attachment is gone but the owned changes remain visible and recoverable. */
  | "detached"
  /** Changes have been folded into the source graph; attachment removed. */
  | "merged"
  /** Deliberately thrown away, with a verified abandon receipt. */
  | "abandoned"
  /** Neither attachment nor owned changes can be found. */
  | "missing"
  /** An operation failed midway; needs a human or a `resume`. */
  | "incident";

export interface WorkspaceRecord {
  readonly version: 2;
  readonly id: WorkspaceId;
  readonly name: string;
  readonly path: string;
  readonly repoRoot: string;
  readonly phase: WorkspacePhase;
  /** Change ids of `parents(@)` captured when the workspace was created. */
  readonly baseChangeIds: readonly string[];
  /** Change id of the workspace's own working copy at creation. */
  readonly rootChangeId: string;
  /** Opaque lifecycle identity used for authority decisions. */
  readonly ownerId?: string;
  /** Human-facing label only; never authority (display ids repeat across roots). */
  readonly ownerDisplayId?: string;
  /** Durable Pi root session which exclusively owns this custody record. */
  readonly rootSessionId: string;
  /**
   * Workspace this one branches from and merges back into.
   *
   * Absent means the user's working copy. Present means a parallel tree: a DPIC
   * run opens a trunk, its subagents branch from the trunk, and only the trunk
   * ever touches the user's copy.
   */
  readonly parent?: WorkspaceId;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Present on `incident`: what failed and where. */
  readonly incident?: { readonly stage: string; readonly reason: string };
  /** Present on `merged`: what landed. */
  readonly merge?: MergeSummary;
}

export type ParentSimplificationReason =
  | "precheck-failed"
  | "pre-existing-redundancy"
  | "no-redundancy"
  | "has-descendants"
  | "redundant-parents-removed"
  | `${"postcheck-failed" | "cosmetic-command-failed"}${"" | "-rolled-back" | "-rollback-failed" | "-rollback-skipped-intervening-operation"}`;

export interface MergeClassification {
  readonly opId: string;
  readonly sourceAt: string;
  readonly sourceUnique: readonly string[];
  readonly sourceEmpty: readonly string[];
  readonly sourceContent: readonly string[];
  readonly incomingHeads: readonly string[];
  readonly attachedHead?: string;
  readonly linearInterior: readonly string[];
  readonly emptyMerges: readonly string[];
  readonly exceptional: readonly { readonly id: string; readonly reason: string }[];
  readonly metadata: readonly {
    readonly id: string;
    readonly description: string;
    readonly author: string;
    readonly authoredAt: string;
    readonly committedAt: string;
  }[];
}

export interface MergePhaseReceipt {
  readonly abandoned: readonly string[];
  readonly preOperation?: string;
  readonly operation?: string;
}

export interface MergeSummary {
  readonly strategy: MergeStrategy;
  /** Change ids folded into the source graph, oldest first. */
  readonly changeIds: readonly string[];
  /** Paths that came back conflicted, if any. Non-empty means user action. */
  readonly conflictPaths: readonly string[];
  /** Cosmetic cleanup of merge-introduced redundant parent edges. */
  readonly parentSimplification?: "applied" | "skipped" | "failed";
  /** Stable, observable explanation for the cosmetic cleanup outcome. */
  readonly parentSimplificationReason?: ParentSimplificationReason;
  readonly classification?: MergeClassification;
  readonly phaseA?: MergePhaseReceipt;
  readonly phaseB?: MergePhaseReceipt;
}

export type MergeResult =
  | { readonly kind: "merged"; readonly record: WorkspaceRecord; readonly summary: MergeSummary }
  /** Target now contains conflicts; source custody is deliberately retained. */
  | {
      readonly kind: "retained_conflicts";
      readonly record: WorkspaceRecord;
      readonly summary: MergeSummary;
    }
  /** The agent produced nothing; the workspace was removed rather than merged. */
  | { readonly kind: "no_changes"; readonly record: WorkspaceRecord }
  /** Refused before mutating anything; `reason` explains what the caller must fix. */
  | { readonly kind: "blocked"; readonly reason: string };

export interface ChangeEntry {
  readonly changeId: string;
  readonly description: string;
  readonly empty: boolean;
  readonly conflicted: boolean;
}

/** What `sweep()` decided about each workspace it inspected at startup. */
export interface SweepEntry {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly disposition: "kept" | "reclaimed" | "needs_attention";
  readonly reason: string;
}

export function isSettled(record: WorkspaceRecord): boolean {
  return record.phase === "merged" || record.phase === "abandoned";
}
