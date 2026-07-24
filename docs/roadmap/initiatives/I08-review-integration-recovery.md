# I08 — Review, integration, and recovery

**Status:** Planned  
**Depends on:** I06, I07

## Outcome

Every nonempty isolated range is checked against durable intent, integrated deterministically into the active source WIP, verified, and recoverable across known interruption boundaries.

## Work slices

1. Thinker-owned repository task-plan artifact and bounded snapshots.
2. Read-only reviewer role, exact range tools, severity/relation schema, and repair budget.
3. Immutable review receipt binding plan hash, root/head/content tip, ordered Change IDs, and normalized patches.
4. Approval gate with clean-rebase tolerance and patch-change re-review.
5. Deterministic integration before source WIP with persisted phase receipts.
6. Owned conflict reviewer→worker→squash→focused-review workflow.
7. Explicit `rebind_tracked_change`, `resume_workspace_operation`, and `retry_workspace_cleanup`.
8. Product and JJ verification receipts.

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
