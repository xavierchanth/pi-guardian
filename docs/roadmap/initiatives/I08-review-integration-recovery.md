# I08 — Review, integration, and recovery

**Status:** Complete  
**Depends on:** I06, I07

## Outcome

Every nonempty isolated range is checked against durable intent, integrated deterministically into the active source WIP, verified, and recoverable across known interruption boundaries.

## Delivered

1. State-owned durable task trees with immutable thinker goals, sourced user directions, child execution bindings, effective plans backed by append-only revisions, role-scoped execution projections, and full-history content-addressed review snapshots.
2. Read-only reviewer role and structured immutable findings using canonical `p0`–`p4` severity and introduced/in-scope/out-of-scope relation.
3. Immutable review bundles and approval receipts binding task snapshot, root/head/content tip, ordered Change IDs, normalized patches, conflicts, findings, and thinker dispositions.
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

## Exit criteria

- No nonempty isolated work integrates without accepted reviewer evidence.
- Integration completion is distinct from product verification.
- Unknown partial mutation enters attention-required with last-safe evidence.
- Conflict resolution is always reported to the user.
- Task plans refresh thinker context without importing child history.
