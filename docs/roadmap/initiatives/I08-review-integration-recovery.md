# I08 — Review, integration, and recovery

**Status:** Complete  
**Depends on:** I06, I07

## Outcome

Every nonempty isolated range is checked against durable intent, integrated deterministically into the active source WIP, verified, and recoverable across known interruption boundaries.

## Delivered

1. State-owned durable task trees with immutable orchestrator goals, sourced user directions, child execution bindings, effective plans backed by append-only revisions, role-scoped execution projections, and full-history content-addressed review snapshots.
2. Read-only reviewer role and structured immutable findings using canonical `p0`–`p4` severity and introduced/in-scope/out-of-scope relation.
3. Immutable review bundles and approval receipts binding task snapshot, root/head/content tip, ordered Change IDs, normalized patches, conflicts, findings, and orchestrator dispositions.
4. Deterministic policy blocks every `p0`/`p1`, requires a disposition for `p2`, and permits one repair plus focused re-review cycle.
5. Receipt-gated integration before source WIP with persisted detach, empty removal, insertion, graph verification, and directory cleanup boundaries.
6. Exact conflict ownership, deterministic resolution squash contracts, and mandatory focused re-review before conflicted integration can become integrated.
7. Sourced-user-authority `rebind_tracked_change`, `resume_workspace_operation`, and `retry_workspace_cleanup` boundaries.
8. Separate JJ/product verification and explicit closed, closed-no-changes, cleanup-pending, conflict-resolution, and attention-required custody.
9. Production task/review/integration tools and role policies; packaged roles no longer use `update_plan`.

## Required proofs

- stale or mismatched review cannot integrate;
- commit-ID-only rewrite does not spuriously invalidate review;
- source WIP bytes/Change ID survive integration;
- only approved inclusive range and empties integrate;
- owned unique conflicts repair; foreign/ambiguous conflicts stop;
- one automatic repair/re-review cycle is enforced;
- crash at every phase resumes only next proved idempotent boundary;
- recovery tools require explicit authority and cannot discard work.

## Open defects in delivered work

Found reviewing the workspace-recovery commits rebased onto the current line on 2026-07-25. The initiative is otherwise complete; these must land before further recovery work builds on it.

| # | Severity | Item |
|---|---|---|
| F1 | **High — resolved** | **Swallowed inspection failures inverted fail-closed.** `WorkspaceRecoveryInspector.inspect` now records `custody_uninspectable` when tracked-range or foreign-descendant inspection fails. Classification prioritizes that discrepancy over every automatic disposition, including `cleanup_pending`, and focused tests prove both failures produce nonautomatic `attention_required` incident preservation. |
| F2 | Medium | **Unreachable dispositions.** `review_stale` and `breached` are in the union, in `actionsFor`, and in the docs, but `classifyWorkspaceRecovery` never returns either. `review_stale` matters most: the snapshot carries no review fields, yet `RECOVERY.md:84` claims the snapshot covers "review". Either wire them or mark them reserved. |
| F3 | Low | **`as any` in the evidence path.** `workspace-recovery.ts` `inspect` casts `identity.rootChangeId as any` and `identity.expectedHeadChangeId as any`. Branded-type escape hatches in the one file whose job is trustworthy evidence; the `changeId()` brand constructor is already imported and used correctly elsewhere. |
| F4 | Low | **Density.** `jj/workspace-file-checkpoint.ts` packs roughly 200 lines of logic into 69; `checkpoint` is one ~30-statement function. Subsumed by the formatter work in I00. |

## Patterns to generalize

**Snapshot-bound plans with digest revalidation.** `reconcile_workspace` re-inspects, re-plans, and refuses if the plan digest has changed:

```ts
if (plan.planId !== params.planId) throw new Error("Recovery plan is stale; inspect and plan the workspace again.");
```

Since `planId` is a digest of the snapshot, this is a compare-and-swap on evidence — the model cannot act on a stale view. **This is the template for every state-mutating tool.** It maps onto I13 D4: `session.set_policy` wants the same guarantee, and `HostCommand.expectedRevision` already exists to carry it.

**Pure classification.** `classifyWorkspaceRecovery` is a pure function from a snapshot to one disposition — no filesystem, no jj, no model. It is the shape I13 D9 requires for configuration resolution, and would port to Rust cleanly if recovery classification ever moves into the Host.

**Non-automatic actions are an ACP affordance.** `WorkspaceRecoveryAction.automatic: false` is what `session/request_permission` or a client attention state should render. Shape the type with that in mind rather than retrofitting.

## Exit criteria

- No nonempty isolated work integrates without accepted reviewer evidence.
- Integration completion is distinct from product verification.
- Unknown partial mutation enters attention-required with last-safe evidence.
- Conflict resolution is always reported to the user.
- Task plans refresh orchestrator context without importing child history.
- No recovery evidence path converts a query failure into an absence of evidence.
- Every disposition in the recovery union is either reachable or explicitly marked reserved.
