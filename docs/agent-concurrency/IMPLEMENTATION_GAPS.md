# Agent concurrency implementation gaps

> Provisional sequencing. The runtime, tool, and blocking-policy documents define the target. Slice ordering should be accepted only after the lifecycle and tool surface are reviewed.

## What already aligns

- Declarative cycle-checked thinker/planner/worker/scout/researcher hierarchy.
- Sparse self-contained task packets with no inherited conversation.
- Durable child records, questions, status reports, terminal reports, usage snapshots, and cleanup guards.
- Concurrent parent work rather than a global parent pause.
- Wait-any collection, hard-submit steering out of stale waits, and recursive status requests.
- JJ-only workspace creation from source `@-` while source `@` may be nonempty.
- Root-only workspace creation/integration and planner/worker workspace targets.
- Change-ID-based ancestry inspection, empty-revision handling, conflict detection, and preserved attention state.
- Hierarchical Active/Inactive/inspect UI without persistent child cards.

## Material gaps

| Area | Current implementation | Target design | Priority |
|---|---|---|---|
| Runtime topology | One subprocess/RPC/FIFO per child | Multiple private Pi SDK `AgentSession` contexts in the root process | P0 |
| Child identity | Durable delegation linked to physical session/log/process | Root-linked private context and multiple execution cycles; not user-selectable sessions | P0 |
| Child events | Parent receives results mainly through tool polling/collection | Typed custom child messages steer active parent or trigger idle parent | P0 |
| Awaiting | `wait_for_children` is the primary delivery path and user steer can sit behind it | `await_child_event` is optional; user input immediately resolves only this wait before normal steering | P0 |
| Parent context | Inspect can project child transcript; terminal result collection can carry large output | Parent receives bounded events/status or focused `request_child_summary`; no history-reading tool | P0 |
| Restart | Reconcile process exit; abandoned logs/session state are external | `/continue` prompt recursively rebuilds contexts; live locks reset and writers reacquire | P0 |
| Child compaction | Subprocess child inherits current CLI behavior indirectly | Every child SDK context uses Pi-Tai auto-compaction and restores compacted state | P1 |
| Hang recovery | Process liveness is the main signal | Heartbeat/status/abort/quiescence proof before a linked replacement cycle | P0 |
| Usage | Recursive intrinsic totals and once-only attribution exist | Root ledger additionally groups by provider/model, role, context, and execution cycle | P1 |
| Native Pi totals | Child usage is returned through current tool results | Async push needs acknowledgement receipt or SDK support for attributable custom messages | P1 |
| Reviewer | No packaged reviewer role | Read-only reviewer with task-plan snapshot and exact inclusive Change-ID inspection | P0 |
| Review loop | Thinker reviews ad hoc; conflicts are fail-stop | Structured severity/relation, one automatic repair cycle, focused re-review | P0 |
| Planner routing | Planner can run as normal shared-cwd child | Planner is workspace-only | P0 |
| Shared writers | Prompt-based re-read and non-overlap advice | Atomic canonical file-set queues held through checkpoint/squash | P0 |
| Pi file queue | Built-in edit/write queue only each individual mutation | Reuse/extend `withFileMutationQueue()` across semantic edit→checkpoint boundary | P0 |
| Shell authority | Worker bash can mutate files/JJ | Shared shell constrained; JJ mutation available only through deterministic tools | P0 |
| JJ boundary | `JjCommandRunner(cwd, args)` and broad workspace service mix process execution with behavior | Strong `JjOperations` consume injected tracked handles/leases; private repository/process executors emit explicit long-form JJ 0.43.0 commands | P0 |
| JJ configuration | Process inherits config implicitly and command construction uses short options | Deliberately inherit identity/signing/policy, never mutate config, and use built-in commands with long-form options | P0 |
| WIP identity | No orchestration-change domain model | `ensure_wip_change` records private mutable WIP and config diagnostics | P0 |
| Task plan | Session plan exists but no repository Markdown task artifact | Thinker-owned concise task-plan file in WIP with bounded snapshots | P1 |
| Shared change target | No deterministic pre-WIP target allocation | `insert_change` returns assigned Change ID and operation receipt | P0 |
| Shared checkpoint | No owned-file deterministic squash target | `checkpoint_change` verifies owner/lock, squashes, checks, then releases | P0 |
| Isolated checkpoint | Planner uses arbitrary shell/JJ history mutation | `workspace_checkpoint` provides deterministic describe+new semantics and records every expected head transition | P0 |
| Workspace source identity | Attachment lacks recorded source WIP/head Change IDs | Capture source WIP, root, expected workspace head, and name/path; base is diagnostic | P0 |
| Workspace boundary | Service validates stored base/root/head topology rigidly | Root, expected workspace head, and content tip resolve exactly once; tolerate clean base rewrite | P0 |
| Workspace pause | Tip captured when integration starts | `prepare_workspace_report` freezes writes and captures head plus last nonempty content tip | P0 |
| Workspace review | Integration follows completed child directly | Acknowledged→normalized→reviewed→approved→integrated | P0 |
| Commit rewrites | Graph mismatch generally fails | Commit-ID-only rewrites refresh; normalized patch change triggers re-review | P0 |
| Conflict handling | Integration conflict enters non-retryable attention | Owned unique conflicts enter reviewer→worker→squash→focused review | P0 |
| Partial mutation | Any error after removal is attention | Known receipt boundaries can resume idempotently; unknown state still stops | P0 |
| Explicit recovery | No bounded tool for a user to adopt a verified replacement Change ID/phase | User-authorized rebind/resume/cleanup tools with audit receipts | P1 |
| Workspace states | `active`, `integrated`, `attention_required` | Full custody including reported, acknowledged, review, repair, conflict, verification, cleanup pending | P0 |
| No-effect closure | Empty integration succeeds without durable closure proof | `closed_no_changes` with empty-range proof | P1 |
| Cleanup | Process artifact cleanup is guarded; workspace cleanup is coarse | `close_workspace` separates semantic closure, disposal, and cleanup pending | P1 |
| UI | Transcript-oriented inspect details exist | Summary/event/review/lock/workspace/usage inspection; no child entry | P2 |

## Tool deltas

The complete target is in [TOOLS.md](TOOLS.md). Major additions/replacements:

- runtime: `spawn_child`, `spawn_workspace_child`, `message_child`, `message_parent`, `await_child_event`, `ack_child_event`, `reconcile_children`;
- context: metadata-only `child_status`, bounded `request_child_status` and focused `request_child_summary`;
- coordination: `acquire_file_set`, `release_file_set`;
- WIP/checkpoint: `jj_concurrency_status`, `ensure_wip_change`, `insert_change`, `checkpoint_change`, `workspace_checkpoint`;
- workspace pause/review: `prepare_workspace_report`, `inspect_change_range`, `inspect_conflicts`, `normalize_change_range`;
- integration/repair: `integrate_workspace`, `squash_resolution`, `verify_integrated_range`, `close_workspace`, `rebind_tracked_change`, `resume_workspace_operation`, `retry_workspace_cleanup`;
- design/accounting: `task_plan`, `concurrency_usage`.

Current `collect_status`, `respond_to_child`, `report_status`, `report_to_parent`, and `wait_for_children` behavior maps into the typed message/acknowledgement model rather than remaining separate historical mechanisms.

## Implementation sequence

The dependency-ordered milestones and parallelizable slices are defined in [IMPLEMENTATION_DAG.md](IMPLEMENTATION_DAG.md). It supersedes a linear C0–C5 sequence so runtime, shared-JJ, workspace-JJ, review, and testing foundations can progress independently where their dependencies permit.

## Required scenario suites

1. **SDK runtime:** parallel child contexts, custom-message steering, idle trigger, wait interruption, root reload, child crash/stall, no duplicate writer.
2. **Context:** metadata status, focused requested summary, terminal report caps, event coalescing, no transcript access, child compaction.
3. **Shared file queues:** exact/ancestor overlap, atomic multi-file set, FIFO waiting, cancellation, pre-lock refresh, in-lock breach.
4. **Shared checkpoints:** ensure empty WIP, unknown nonempty `@`, `insert_change`, assigned Change ID, `checkpoint_change` before release, unrelated WIP preservation.
5. **Isolated checkpoints:** workspace-wide writer token, repeated `workspace_checkpoint`, exact head transitions, empty final head, interrupted operation.
6. **Workspace identity:** dirty source, clean base rebase, commit-ID rewrite, root/head/content-tip connectivity, divergent/unexpected ID, foreign head.
7. **Review:** plan snapshot, inclusive range, names, empty changes, goal drift, severity relation, one-cycle budget.
8. **Conflicts:** owned unique resolution, multiple target changes, foreign conflict, ambiguous squash target, focused re-review, user conflict report.
9. **Resume/recovery:** `/continue`, lock reset/reacquisition, nested descendants, unanswered question, known integration boundary, explicit user-authorized rebind.
10. **Usage/UI:** per-model/role/context totals exactly once; no child entry; summaries/findings/locks/receipts; truncation/navigation.
