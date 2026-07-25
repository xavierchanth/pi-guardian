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

| Capability | Thinker | Planner | Worker | Reviewer | Scout | Researcher |
|---|---:|---:|---:|---:|---:|---:|
| Implement | yes | yes | yes | no | no | no |
| Create normal children | yes | worker/scout/researcher | scout/researcher | scout/researcher | no | no |
| Create isolated workspace child | yes | no | no | no | no | no |
| Message/status/await/ack direct child | yes | yes | yes | yes | no | no |
| Shared file claim/checkpoint | owned | no | owned | no | no | no |
| Isolated checkpoint/report | no | owned | owned | no | no | no |
| Rebase/integrate/close workspace | yes | no | no | no | no | no |
| Inspect exact range/conflicts | yes | owned | bounded | read | no | no |
| Review exact range | decision | self-check | self-check | yes | no | evidence |
| Web research | yes | yes | no | yes | no | yes |
| Recovery rebind/resume | user-authorized | no | no | no | no | no |

## Parent/child tools

### `spawn_child`

Creates a private child in caller cwd from a role and task packet. Returns launch identity immediately; completion arrives by event. Planner is excluded because planners require isolated workspace allocation.

### `spawn_workspace_child`

Atomic thinker-only operation: validate source/WIP, allocate managed JJ workspace from source `@-`, capture exact identities/custody, then start planner or isolated worker. Startup failure preserves custody. No fallback to shared execution.

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

### `acquire_file_set`

Atomically queues a complete repository-relative semantic path set. Existing paths canonicalize directly and new paths through the nearest existing ancestor. Equal and ancestor/descendant paths collide. A set grants only when no active claim or earlier overlapping waiter conflicts; disjoint sets may run concurrently. Returns a claim only after complete grant and fresh-read requirement. Restart interrupts persisted queued/active/checkpointing claims rather than restoring authority or queue position.

### `release_file_set`

Releases unused or fully checkpointed ownership. Rejects uncheckpointed owned changes.

## JJ tools

### `jj_concurrency_status`

Read-only source/workspace identities, WIP state, mutability, conflicts, divergence, stale/recovery evidence, managed workspaces, and lock state. Commit IDs are diagnostic.

### `ensure_wip_change`

Verifies an existing recorded WIP, safely adopts an existing canonical WIP after strict validation, or canonically describes an empty current change. Unknown nonempty source work returns `decision_required` rather than silent rewrite. Reports mutability, conflicts, and private-protection diagnostics without changing configuration.

### `insert_change`

Creates a named empty assigned feature change before source WIP. Model supplies description/owner; handler injects source identity and insertion point.

### `checkpoint_change`

Consumes the caller's active claim and assigned target. Moves only locked paths, preserves unrelated WIP content/identity, checks conflicts, records receipt, and releases claim.

### `workspace_checkpoint`

Model input is only a semantic description. Injected writer lease supplies workspace and expected head. Describes current head, creates one fresh empty child, records exact head transition, then releases token.

### `rebase_workspace`

Thinker-only manual operation onto source parent or one exact local Change ID. Moves exact root plus owned descendants under token/mutex and returns range-equivalent, range-changed, or conflicted receipt.

### `prepare_workspace_report`

Requires descendants acknowledged and writer settled; verifies expected head, derives content tip, freezes writes, and produces exact bounded report evidence.

### `inspect_change_range` / `inspect_conflicts`

Bounded read-only metadata, normalized patches, changed paths, conflicts, ownership, and artifact references for exact inclusive range.

### `normalize_change_range`

Removes exact safe interior empties and applies supplied semantic descriptions while preserving tracked root and active empty head.

### `integrate_workspace`

Thinker-only and review-receipt-gated. Revalidates under mutex, performs documented phases, preserves source WIP, and returns durable integration/conflict/cleanup receipt.

### `squash_resolution`

Consumes conflict file claim and exact owned target; squashes only resolution paths and verifies conflict removal.

### `verify_integrated_range`

Read-only graph verification against review/integration receipts. Product acceptance remains separate.

### `close_workspace`

Transitions custody to closed, closed-no-changes, cleanup-pending, or explicit preserved incident based on receipts.

## Recovery and accounting

- `rebind_tracked_change`: explicit user-authorized adoption of unique verified replacement.
- `resume_workspace_operation`: continue next proved idempotent phase.
- `retry_workspace_cleanup`: repeat exact cleanup only.
- `task_create`: thinker-owned immutable root goal from sourced user intent.
- `task_assign`: immutable child assignment bound to one execution context.
- `task_plan`: thinker/planner replacement of the caller-owned effective plan, backed by append-only revisions and optional sourced direction IDs.
- `task_record_user_direction`: thinker-only sourced user clarification.
- `task_status`: role-scoped projection—full history for thinker, effective owned subtree for planner, and effective authority lineage for worker.
- deterministic review snapshot: full task-tree history with current and superseded revisions clearly distinguished in immutable content-addressed Markdown evidence.
- `concurrency_usage`: exact bounded totals by model, role, context, and cycle.

## Cancellation boundaries

- Event waits, lock waits, subprocesses, and network operations propagate the active `AbortSignal` and settle promptly.
- Durable repository mutations finish or stop only at a proved operation boundary; cancellation remains `pending` while that boundary settles.
- In-process SDK disposal is not a hard-kill mechanism and is never treated as proof of quiescence.
- Root disposal uses the same bounded drain rule and records interrupted execution when quiescence is not yet proved.

## Constrained built-ins

- Write/edit require covering claim in shared source or writer token in isolated workspace.
- Shell cannot perform managed JJ mutation.
- Shared worker shell uses a conservative read/validation allowlist and cannot mutate source outside wrapped tools.
- Successful guarded writes refresh owned fingerprints; bypassed mutations breach before checkpoint.
- Validation may write declared build/cache outputs only.
- Reviewer/scout/researcher shell remains read-only except isolated temporary artifacts.
- Parent models cannot point read/search tools at private child journals.

## Intentionally absent

- arbitrary mutating JJ command tool;
- enter/read-child-session tool;
- planner/worker nested workspace creation;
- automatic push/bookmark/config tool;
- generic rollback or force-remove tool;
- reviewer-to-repair-worker delegation;
- unrestricted mutating revset input.
