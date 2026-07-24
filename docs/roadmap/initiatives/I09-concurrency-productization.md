# I09 — Concurrency productization

**Status:** Planned  
**Depends on:** I08

## Outcome

Concurrency has complete custody/closure semantics, bounded multi-client projections, exact accounting, and no legacy child-process, polling, transcript, or broad workspace paths.

## Scope

- Implement closed, closed-no-changes, cleanup-pending, and incident projections.
- Complete usage attribution by provider/model, role, context, and cycle.
- Present active/inactive child hierarchy, questions, findings, claims, workspace state, receipts, and usage without exposing child sessions.
- Persist concurrency state through Host session services.
- Migrate/quarantine older child/delegation records.
- Remove subprocess/FIFO launch and control paths.
- Remove polling/transcript-era aliases and raw history projection.
- Replace old broad workspace service with semantic operations.
- Remove compatibility persistence cycle between concurrency and subagents.
- Run complete package, SDK, Real-JJ, Host-recovery, and optional live benchmarks.

## Exit criteria

- Production launches only private SDK child contexts.
- No model-facing tool reads child history.
- No duplicate workspace/session authority remains.
- Every workspace has one honest terminal custody state.
- Cleanup cannot destroy unresolved work or hide semantic failure.
- Client UI is summary/event/receipt-based and has no child-entry action.
- Compatibility code has no callers and is deleted, not merely deprecated.
