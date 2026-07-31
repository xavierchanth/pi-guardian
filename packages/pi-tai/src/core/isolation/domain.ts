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
export type MergeStrategy =
  /** Pick per the decision rule: linear when it is clean, merge-under otherwise. */
  | "auto"
  /** Insert the agent range directly below `@`, keeping history linear. */
  | "linear"
  /** Re-parent `@` onto its existing parents plus the agent head. */
  | "merge-under";

export type WorkspacePhase =
  /** Directory and jj workspace exist; an agent may be writing. */
  | "active"
  /** Changes have been folded into the source graph; attachment removed. */
  | "merged"
  /** Deliberately thrown away. */
  | "discarded"
  /** An operation failed midway; needs a human or a `resume`. */
  | "incident";

export interface WorkspaceRecord {
  readonly version: 1;
  readonly id: WorkspaceId;
  readonly name: string;
  readonly path: string;
  readonly repoRoot: string;
  readonly phase: WorkspacePhase;
  /** Change ids of `parents(@)` captured when the workspace was created. */
  readonly baseChangeIds: readonly string[];
  /** Change id of the workspace's own working copy at creation. */
  readonly rootChangeId: string;
  /** Owner label, normally the subagent id that the workspace was created for. */
  readonly owner?: string;
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

export interface MergeSummary {
  readonly strategy: Exclude<MergeStrategy, "auto">;
  /** Change ids folded into the source graph, oldest first. */
  readonly changeIds: readonly string[];
  /** Paths that came back conflicted, if any. Non-empty means user action. */
  readonly conflictPaths: readonly string[];
  /** Cosmetic cleanup of merge-introduced redundant parent edges. */
  readonly parentSimplification?: "applied" | "skipped" | "failed";
  /** Stable, observable explanation for the cosmetic cleanup outcome. */
  readonly parentSimplificationReason?: ParentSimplificationReason;
}

export type MergeResult =
  | { readonly kind: "merged"; readonly record: WorkspaceRecord; readonly summary: MergeSummary }
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
  return record.phase === "merged" || record.phase === "discarded";
}
