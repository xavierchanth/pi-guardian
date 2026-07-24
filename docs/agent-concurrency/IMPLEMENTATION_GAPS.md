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
| Runtime topology | New launches use private in-process SDK contexts; subprocess launcher remains for v3 recovery | Remove final legacy subprocess/FIFO code after downstream parity | P2 |
| Child identity | Version-4 root-linked contexts/cycles plus a temporary version-3 compatibility projection | Remove compatibility projection after F4 migration | P2 |
| Child events | Hidden typed push events and explicit acknowledgement implemented; old collection aliases remain | Remove polling/transcript-era aliases after prompt/tool migration | P1 |
| Awaiting | `await_child_event` and immediate input interruption implemented; `wait_for_children` remains compatible | Remove polling implementation after all prompts migrate | P1 |
| Parent context | New protocol is bounded; legacy inspect can still read old transcript logs | Eliminate legacy transcript projection in F4 | P1 |
| Restart | Post-order v4 reconciliation and `/continue` implemented; legacy records remain mutation-stopped | Add downstream JJ receipt classifiers as C/D/E tools land | P1 |
| Child compaction | New SDK children register independent Pi-Tai compaction and private journals | Add production threshold/reopen stress coverage as usage grows | P2 |
| Hang recovery | Process liveness is the main signal | Heartbeat/status/abort/quiescence proof before a linked replacement cycle | P0 |
| Usage | Recursive intrinsic totals and once-only attribution exist | Root ledger additionally groups by provider/model, role, context, and execution cycle | P1 |
| Native Pi totals | Child usage is returned through current tool results | Immutable side ledger is authoritative; reconcile native totals where possible without adding usage at delivery/acknowledgement | P1 |
| Reviewer | No packaged reviewer role | Read-only reviewer with task-plan snapshot and exact inclusive Change-ID inspection | P0 |
| Review loop | Thinker reviews ad hoc; conflicts are fail-stop | Structured severity/relation, one automatic repair cycle, focused re-review | P0 |
| Planner routing | Planner can run as normal shared-cwd child | Planner is workspace-only | P0 |
| Shared writers | Atomic canonical FIFO file-set claims now cover edit→validation→checkpoint; ancestor collisions and restart recovery are enforced | Extend the same claim model into later conflict-resolution paths | P1 |
| Pi file queue | Semantic claims guard Pi `write`/`edit` while each mutation still uses Pi's native per-file queue; bypasses breach before checkpoint | Generalize guarded tool wrapping beyond the shared-source lane | P1 |
| Shell authority | Shared workers have a conservative read/validation allowlist and cannot mutate JJ through bash | Reuse equivalent constraints for isolated reviewer/repair roles | P1 |
| JJ boundary | M2 shared operations use opaque handles, exact resolvers, a repository mutex, and long-form JJ 0.43.0 argv; legacy workspace service remains | Migrate D/E workspace behavior onto the semantic kernel | P0 |
| JJ configuration | M2 inherits identity/signing/immutability, diagnoses private protection, and never mutates config | Migrate remaining legacy workspace argv to the same contract | P1 |
| WIP identity | `ensure_wip_change` records/adopts private mutable WIP, refuses unknown nonempty work, and reports config protection | Add explicit user-authorized WIP rebind in F0 | P1 |
| Task plan | Session plan exists but no repository Markdown task artifact | Thinker-owned concise task-plan file in WIP with bounded snapshots | P1 |
| Shared change target | `insert_change` creates an exact owner-bound empty target before preserved WIP | Bind task-plan snapshots when E0 lands | P2 |
| Shared checkpoint | `checkpoint_change` moves only claimed paths, preserves unrelated WIP evidence, receipts before release, and reconciles interruption | Reuse receipts in E3 integration and F0 recovery UI | P1 |
| Isolated checkpoint | Planner uses arbitrary shell/JJ history mutation | `workspace_checkpoint` provides deterministic describe+new semantics and records every expected head transition | P0 |
| Workspace rebase | No bounded manual operation; current service assumes recorded base/root topology | Thinker-only `rebase_workspace` moves exact owned descendants to source `@-`/exact local Change ID while preserving range identities | P1 |
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
- workspace lifecycle/review: `rebase_workspace`, `prepare_workspace_report`, `inspect_change_range`, `inspect_conflicts`, `normalize_change_range`;
- integration/repair: `integrate_workspace`, `squash_resolution`, `verify_integrated_range`, `close_workspace`, `rebind_tracked_change`, `resume_workspace_operation`, `retry_workspace_cleanup`;
- design/accounting: `task_plan`, `concurrency_usage`.

Current `collect_status`, `respond_to_child`, `report_status`, `report_to_parent`, and `wait_for_children` behavior maps into the typed message/acknowledgement model rather than remaining separate historical mechanisms.

## Implementation sequence

The dependency-ordered milestones and parallelizable slices are defined in [IMPLEMENTATION_DAG.md](IMPLEMENTATION_DAG.md). It supersedes a linear C0–C5 sequence so runtime, shared-JJ, workspace-JJ, review, and testing foundations can progress independently where their dependencies permit. The accepted B0–B4 cutover details are in [M1_IMPLEMENTATION_PLAN.md](M1_IMPLEMENTATION_PLAN.md).

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
