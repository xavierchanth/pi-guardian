# I09 — Concurrency productization

**Status:** Complete  
**Depends on:** I08

**Superseded:** The delegation model described here — named agent roles, durable work orders, and the review, integration, and recovery tool families — was replaced by the subagent and workspace design in [docs/concurrency/README.md](../../concurrency/README.md). This document is kept as a record of what was built at the time and is not a description of the current system.

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
- Compatibility paths have no production callers; explicit test and one-way import adapters cannot become authorities.

## Delivered

- Host-acknowledged, revision-checked aggregate transactions persist private concurrency state and bounded public projections atomically.
- `/init-pi-tai` enrolls repositories with resumable consent, repo-local `pi_tai_private()` policy, and Host-bound receipts.
- Each enrolled Host session receives an independently custodied workspace under `.jj/pi-tai/workspaces/sessions/`, based on invoking `@-` and described `pi-tai: session <id>`.
- Tasks, reviews, child contexts, claims, isolated workspaces, repository leases, session custody, exact usage, and telemetry gaps use Host-owned persistence in hosted production.
- Child lifecycle uses private in-process Pi SDK contexts and pushed semantic events. Production excludes subprocess/FIFO launch, transcript-derived views, `update_plan`, `wait_for_children`, `child_status`, and `collect_status`.
- Projections bound task, child, question, workspace, claim, receipt, incident, and usage summaries without session files, journals, PIDs, histories, or child-entry actions.
- Usage is deduplicated by cycle/message identity and grouped by provider/model, role, context, and cycle; missing identities or usage become durable telemetry gaps.
- Restart verifies existing session custody, interrupts unproved writers, resumes only private SDK journals with durable identity, and refuses ambiguous JJ mutation.
- Cleanup is receipt/custody gated and refuses to discard a nonempty session orchestration change.
- One-way migration imports only quiescent identity-proved v3 records and quarantines subprocess state, unproved writers, terminal records without exact cycle identity, ambiguous workspaces, and conflicting mirrors.
- Canonical role projections expose only Orchestrator, Implementation Lead, Documenter, Worker, Reviewer, Scout, and Researcher. Persisted `thinker` and `planner` identifiers are accepted only as legacy migration inputs and normalize to canonical roles.
- UI and accounting report canonical role names, explicit plan-bound assignment state, isolated workspace custody, and review/integration status.

## Validation

- TypeScript typecheck and the full package/runtime/integration/Real-JJ test suite pass.
- Full Rust workspace tests pass, including Host restart continuity, aggregate CAS/idempotency, exact accounting, protocol fixtures, ACP reconnect, and runtime supervision.
- Isolated Real-JJ tests prove repository enrollment, multi-session workspace allocation/recovery/cleanup, isolated review/integration, shared claims, and preservation of invoking user `@`.
