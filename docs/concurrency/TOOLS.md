# Agents and deterministic tools

## Principles

1. Models choose intent, semantic scope, descriptions, and findings.
2. Deterministic tools choose exact identities, claims, revsets, mutation order, receipts, and postcondition checks.
3. Tool handlers inject opaque tracked handles and active leases.
4. Mutating tools are scoped to one context and workspace.
5. Read-only tools return bounded projections, not transcripts or unbounded diffs.
6. Parent/child protocol uses custom messages, not user messages.
7. Checkpoint/squash retains ownership until receipt verification.

## Role authority

Legend: **yes**, **owned** (only with injected authority), **read**, or **no**.

| Capability | Orchestrator | Implementation Lead | Worker | Documenter | Reviewer | Scout | Researcher |
|---|---:|---:|---:|---:|---:|---:|---:|
| Collaborate with user on design/plan | yes | no | no | no | no | evidence | evidence |
| Implement product work | no | yes | owned | no | no | no | no |
| Modify standalone documentation | no | yes | owned | owned | no | no | no |
| Create normal children | lead/documenter/reviewer/scout/researcher | worker/scout/researcher | scout/researcher | no | scout/researcher | no | no |
| Create isolated workspace child | yes | no | no | no | no | no | no |
| Message/status/await/ack direct child | yes | yes | yes | no | yes | no | no |
| Isolated file claim/checkpoint | no | owned | owned | owned docs | no | no | no |
| Rebase/integrate/close workspace | yes | no | no | no | no | no | no |
| Inspect exact range/conflicts | yes | owned | bounded | bounded | read | no | no |
| Review exact range | disposition | self-check | self-check | self-check | yes | no | evidence |
| Web research | yes | yes | no | no | yes | no | yes |
| Recovery rebind/resume | deterministic | no | no | no | no | no | no |

## Parent/child tools

### `spawn_child`

Creates a private read-only evidence child or a same-workspace child allowed by the role graph. Returns launch identity immediately; completion arrives by event. Implementation Leads and Documenters require isolated workspace allocation.

### `spawn_workspace_child`

Atomic Orchestrator-only operation: require a task bound to a persisted Orchestrator plan, resolve source `@-` when allocation executes, capture only the managed workspace range identities and custody, then start an Implementation Lead or Documenter. Startup failure preserves custody. No fallback to shared execution.

### `message_child` / `message_parent`

Typed bounded protocol for instruction, question response, status, result, review, and continuation. Child result is rejected with unresolved/unacknowledged direct descendants.

### `request_child_status`

Correlated bounded semantic request answered inside child context, followed by continuation. Optional `focus` and `questions` fields add focused asks without requiring a separate summary tool.

### `await_child_event`

Token-free wait-any barrier. Interactive input resolves only the wait.

### `ack_child_event`

Idempotently acknowledges one event and imports usage once.

### `cancel_child` (`abandon_child` compatibility name)

Durably requests cancellation for the selected cycle/subtree, signals descendants before parents, and preserves workspace custody. The call is bounded: it returns either `cancelled` after runtime and mutation quiescence are proved, or `pending` with the exact contexts still settling. Pending cancellation never auto-resumes after restart and is never presented as terminal cancellation.

### `reconcile_children`

Post-order durable reconciliation. Refuses duplicate writers and requires claims to be reacquired.

## Coordination tools

The shared-source worker lane (`insert_change`, `acquire_file_set`, `release_file_set`, and `checkpoint_change`) is retired from production. The Orchestrator owns the main workspace, while concurrent writable children coordinate only through isolated-workspace file claims.

## JJ tools

### `jj_concurrency_status`

Read-only source/workspace identities, source base and working-change state, mutability, conflicts, divergence, stale/recovery evidence, managed workspaces, and lock state. Commit IDs are diagnostic.

### `assign_workspace_change` / `acquire_workspace_file_set`

The orchestrator assigns one target Change ID to a writable task inside its isolated workspace. The child requests one complete semantic path set; disjoint sets in the same workspace may grant concurrently while overlaps queue atomically.

### `checkpoint_workspace_file_set`

Injected workspace, claim, owner, target, and stable-WIP evidence constrain the operation. It moves only claimed paths into the assigned target, proves unrelated WIP content unchanged, persists the receipt, and releases the claim.

### `rebase_workspace`

Orchestrator-only manual operation onto source `@-` resolved when the rebase executes, or one exact local Change ID. Moves exact root plus owned descendants under token/mutex and returns range-equivalent, range-changed, or conflicted receipt.

### `prepare_workspace_report`

Requires descendants acknowledged and writer settled; verifies expected head, derives content tip, freezes writes, and produces exact bounded report evidence.

### `inspect_change_range` / `inspect_conflicts`

Bounded read-only metadata, normalized patches, changed paths, conflicts, ownership, and artifact references for exact inclusive range.

### `normalize_change_range`

Removes exact safe interior empties and applies supplied semantic descriptions while preserving tracked root and active empty head.

### `integrate_workspace`

Orchestrator-only and clean-review-receipt-gated. Revalidates under mutex, inserts the reviewed range immediately before source `@` as resolved by the integration operation, and returns a durable integration, conflict, or cleanup receipt.

### `start_review_repair`

Persists one explicit repair attempt bound to the current blocking finding IDs, exact affected paths, prior review, original implementation role, and repair work order before launching the repair child. Startup failures remain visible as attention-required repair evidence; every completed attempt returns through freeze and focused review.

### `reconcile_integration_conflicts`

After the Orchestrator resolves recorded integration conflicts with Bash/JJ, places exact resolved paths into uniquely owning integrated changes, verifies conflict removal and range identity, records a reconciliation receipt, and requires focused review.

### `verify_integrated_range`

Read-only graph verification against review/integration receipts. Product acceptance remains separate.

### `close_workspace`

Transitions custody to closed, closed-no-changes, cleanup-pending, or explicit preserved incident based on receipts.

## Recovery and accounting

- `rebind_tracked_change`: deterministic adoption of one unique verified connected replacement.
- `resume_workspace_operation`: deterministically continue the next proved idempotent phase.
- `retry_workspace_cleanup`: deterministically repeat exact managed cleanup only.
- `workspace_custody_status`: inspect expected and observed JJ custody facts in every phase.
- `workspace_recovery_plan`: classify one snapshot into a complete fact-driven disposition and bounded actions.
- `reconcile_workspace`: revalidate a snapshot-bound plan and execute one exact recovery action.
- `work_order_create`: persists execution class, objective, instructions, rationale, acceptance criteria, constraints, resources, validation requirements, documentation requirements, and status updates; `small-product`, `large-product`, and `documentation` select Worker, Implementation Lead, and Documenter respectively.
- `workspace_subagent`: accepts a work-order ID and derives role and child packet from durable authority rather than accepting duplicate instructions.
- `work_order_revise`: Orchestrator/Implementation Lead replacement of current effective instructions, backed by append-only revisions and optional sourced direction IDs.
- `work_order_record_user_direction`: orchestrator-only sourced user clarification.
- `work_order_status`: role-scoped projection—full history for Orchestrator, effective owned subtree for Implementation Lead, and effective authority lineage for Worker.
- deterministic review snapshot: full work-order history with current and superseded instructions clearly distinguished in immutable content-addressed Markdown evidence.
- `concurrency_usage`: exact bounded totals by model, role, context, and cycle.

## Cancellation boundaries

- Event waits, lock waits, subprocesses, and network operations propagate the active `AbortSignal` and settle promptly.
- Durable repository mutations finish or stop only at a proved operation boundary; cancellation remains `pending` while that boundary settles.
- In-process SDK disposal is not a hard-kill mechanism and is never treated as proof of quiescence.
- Root disposal uses the same bounded drain rule and records interrupted execution when quiescence is not yet proved.

## Constrained built-ins

- The Orchestrator may use Bash/JJ in the main workspace for investigation, immediate work, and conflict reconciliation.
- Writable children require a writer token or covering file claim in an isolated workspace.
- Successful guarded writes refresh owned fingerprints; bypassed mutations breach before checkpoint.
- Validation may write declared build/cache outputs only.
- Reviewer/scout/researcher shell remains read-only except isolated temporary artifacts.
- Parent models cannot point read/search tools at private child journals.

## Intentionally absent

- arbitrary mutating JJ command tool;
- enter/read-child-session tool;
- Implementation Lead/Worker/Documenter nested workspace creation;
- automatic push/bookmark/config tool;
- generic rollback or force-remove tool;
- reviewer-to-repair-worker delegation;
- unrestricted mutating revset input.
