# Agent concurrency subsystem

This subsystem coordinates concurrent agents and the work they produce. It covers role selection, task ownership, shared-directory safety, isolated JJ workspaces, parent/child communication, result collection, review, integration, verification, and recovery. It does not define the broader Host, ACP, Desktop, or product roadmap.

## Use-case matrix

### Work routing

| ID | User situation | Required route | Primary owner | Done only when |
|---|---|---|---|---|
| U1 | Small, local, sequential change | Thinker works inline | Thinker | Change is validated and, if material, deterministically checkpointed |
| U2 | Focused codebase reconnaissance | Normal `scout` child in caller cwd | Caller | Evidence is collected and incorporated |
| U3 | Current external or source-backed research | Normal `researcher` child | Caller | Sourced conclusions are collected and incorporated |
| U4 | Bounded implementation with a known file set | Normal `worker` child may share caller cwd | Caller | Edit/checkpoint lock is released, result is acknowledged, and caller validates it |
| U5 | Bounded implementation that may overlap active work | Isolated `worker` workspace | Thinker | Workspace is reviewed, integrated, verified, and closed |
| U6 | Substantial work requiring decomposition | Isolated `planner` workspace | Thinker | Planner history is reviewed, integrated, verified, and closed |
| U7 | Several unrelated substantial slices | One isolated planner or worker workspace per slice | Thinker | Every child is separately acknowledged, reviewed, integrated, verified, and closed |
| U8 | Related slices that depend on the same evolving files | Keep them sequential under one owner, usually one planner workspace | Thinker or planner | One owner integrates the complete coherent result |
| U9 | User explicitly asks to avoid the main working copy | Isolated worker or planner workspace automatically | Thinker | Main working copy is untouched until approved integration |
| U10 | User explicitly asks to inspect/create/integrate/clean workspace state | Deterministic workspace administration, not delegated implementation | Thinker | Requested lifecycle operation has a verified receipt or stops for attention |
| U11 | Pure planning with no implementation | Thinker plans inline; use scouts/researchers for evidence | Thinker | User receives a decision-ready plan |
| U12 | A planner needs bounded implementation help | Normal workers inside the planner's already-isolated cwd | Planner | Every worker result is acknowledged and planner validates the whole slice |
| U46 | Thinker needs to verify implementation against the original goal | Read-only `reviewer` receives the task plan and inclusive workspace Change-ID range | Thinker | Structured findings are classified and acknowledged |
| U47 | Root context has gone stale while isolated work ran | Thinker refreshes from its concise task-plan Markdown and child summary | Thinker | Root can review without reading child history |
| U48 | Shared workers need the same file | Queue the complete canonical file set | Coordinator | Each worker edits and checkpoints/squashes before the next acquires it |

### Parent/child interaction

| ID | Situation | Required behavior | Forbidden shortcut |
|---|---|---|---|
| U13 | Parent has launched children | Parent may do independent non-overlapping work | Treating delegation as completion |
| U14 | Any child completes or asks a question | Push a bounded custom child message into the parent at Pi's safe steer boundary | Polling or impersonating a user message |
| U15 | Parent has no independent work | `await_child_event` suspends token-free and wakes on one pushed event | Repeated model polling |
| U16 | Child asks a correlated question | Parent answers that exact question through `message_child` | Sending an uncorrelated message or settling the child |
| U17 | Parent communicates with a running child | Deliver a custom parent message to the managed child context | Mutating the child's files behind its ownership boundary |
| U18 | Child is suspended awaiting descendants when messaged | Abort only the stale await, deliver the message, then restore the saved resume point | Cancelling descendants |
| U19 | User requests metadata status | Read only coordinator lifecycle metadata | Reading child history or waking it unnecessarily |
| U20 | User requests semantic status | Ask the child for a bounded correlated summary, then resume its prior activity | Importing transcript or treating status as terminal |
| U21 | User speaks while root awaits | Cancel only the active root await and handle the message | Cancelling children |
| U22 | Parent reaches apparent completion with active children | Deterministic completion gate requires every direct child terminal and acknowledged | Ending because no child event is currently queued |
| U49 | Root Pi process restarts and user invokes `/continue` | Reconcile and recreate resumable child SDK contexts recursively | Relaunching terminal or incident-blocked work |
| U50 | Child crashes or stalls | Preserve its context, prove old writer quiescent, then start a linked recovery cycle | Running duplicate writers |

### JJ change and workspace handling

| ID | Situation | Required behavior | Completion proof |
|---|---|---|---|
| U23 | Main workspace contains ongoing work | Keep one mutable private `wip:` orchestration Change ID | Readiness check confirms identity and warns if private protection is missing |
| U24 | Quick shared-workspace work is complete | Checkpoint only explicitly owned paths into a named feature change | Receipt records before/after identities, paths, and validation |
| U25 | Shared tasks need the same path | Queue their complete file sets; optionally reroute a long waiter to isolation | Edit/checkpoint critical sections never overlap |
| U26 | Isolated work is created while source `@` is nonempty | Branch isolated root from recorded source `@-` | Source `@` identity and file content are unchanged by creation |
| U27 | Source continues changing while isolated work runs | Allow independent work under ownership rules | Integration revalidates source identity and current topology |
| U28 | Planner finishes meaningful work | Curate owned history into named feature changes and leave no unexplained residue | Planner report includes validation and exact range/tip |
| U29 | Workspace contains several meaningful revisions | Preserve their dependency order and review all of them | Approved review receipt covers the complete range |
| U30 | Workspace contains empty intermediate or working-copy revisions | Remove them before approval when safe; integration verifies no unreviewed empties remain | Reviewed and integrated Change-ID sets match |
| U31 | Workspace made no effective change | Prove the delegated range is empty and close `closed_no_changes` | No synthetic commit or description is created |
| U32 | Completed workspace is unexpectedly non-curated or changed after report | Refresh if a known clean rewrite is patch-equivalent; otherwise request re-review | Root/head/content-tip and review receipt agree |
| U33 | Integration targets a dirty source `@` | Insert approved feature changes before the same orchestration Change ID | Source content is preserved and source identity is verified |
| U34 | Rebase/integration records owned conflicts | Reviewer classifies them; thinker assigns a bounded locked worker; deterministically squash resolutions and re-review | Inclusive range is named, nonempty, conflict-free, and approved |
| U35 | Mutation stops between known deterministic phases | Reconcile receipts and continue from the next proved idempotent boundary | Never guess rollback or repeat an unproved phase |
| U51 | Workspace base is rebased onto newer main | Continue by stable root/head/content-tip Change IDs when the inclusive range remains valid and conflict-free | Commit-ID changes are ignored |
| U52 | Root/head/tip identity is divergent or foreign work enters the range | Stop affected mutation and preserve diagnostics | No arbitrary side selection |
| U53 | Isolated worker completes a coherent unit | Call `workspace_checkpoint` (deterministic describe+new) | Prior head is named and new empty head Change ID is recorded exactly |
| U54 | Tracked Change ID changes without a tool receipt | Stop automatic mutation; inspect and offer explicit user-authorized rebind/resume tools | Never silently adopt replacement identity |
| U55 | User wants isolated work moved onto newer fetched trunk/base | Pause writers and call `rebase_workspace` with source `@-` or one exact local Change ID | Root/content-tip/head and range membership remain unchanged; old/new root parent is receipted |
| U36 | Private-change protection is absent | Explain the recommended `git.private-commits` selector | Pi-Tai does not edit user JJ config |
| U37 | User asks to publish | Leave publishing outside this subsystem unless separately authorized | No automatic push, bookmark, or config mutation |

### Failure, cleanup, and observability

| ID | Situation | Required behavior | Data retained |
|---|---|---|---|
| U38 | Child fails or is blocked with useful workspace work | Preserve workspace custody for review, resumption, or explicit disposal | Report, tip, range, logs, and recovery path |
| U39 | Parent abandons a process | Terminate its descendant tree and snapshot usage first | Durable records and workspace remain unless separately closed |
| U40 | Disposable runtime artifacts are cleaned | Delete only exact managed paths after containment and symlink checks | Durable delegation records, session history, usage snapshot |
| U41 | Pi/runtime restarts | Reconcile durable records and recreate safe resumable in-process child contexts | No lifecycle is advanced from object absence alone |
| U42 | User inspects active work | Show unresolved hierarchy with filesystem connectors | Stable IDs, roles, objective, phase, locks, workspace state, latest summary |
| U43 | User inspects historical work | Retain terminal descendants in Inactive/inspect views | Bounded reports, lifecycle events, findings, and recursive usage—not model-visible transcripts |
| U44 | Recursive cost is reported | Keep one root ledger with totals by model, role, context, and execution cycle | Each intrinsic usage event is counted once |
| U45 | Status request times out | Return metadata plus timed-out IDs without changing lifecycle | Existing children continue |

## Requirements distilled from the design discussion

1. **Concurrency is one process with isolated SDK contexts.** Children are deeply linked managed `AgentSession` contexts, not subprocesses or user-selectable Pi sessions.
2. **JJ is the only managed workspace backend.** No probing fallback to Git and no backend switch after mutation begins.
3. **The main workspace is useful while children run.** The thinker may continue independent work; shared writes use canonical file-set queues whose critical section includes edit, validation, checkpoint/squash, and receipt verification.
4. **Only the thinker creates isolated workspaces.** A planner coordinates work inside the one workspace it was given; no child recursively allocates another workspace.
5. **Planner means substantial isolated slice.** A planner is not a generic extra thinker and is never the route for a trivial task or a normal shared-cwd child.
6. **Worker means bounded implementation.** It can run shared only with an exclusive lease; otherwise it runs isolated. It may delegate read-only reconnaissance, not another writer hierarchy.
7. **Child events are pushed; awaiting is optional.** Custom child messages steer an active parent or trigger an idle one. Awaiting remains a token-free barrier, not a polling requirement.
8. **Parents receive summaries, never histories.** Metadata status is local; semantic status, questions, completion, and review arrive as bounded child-authored reports.
9. **Delegation is not completion.** A deterministic gate requires every direct child to be terminal and its bounded report acknowledged.
10. **Status is nonterminal.** A correlated status turn reports and automatically resumes the saved child activity.
11. **The thinker owns workspace custody.** A child report means “ready for thinker review,” never “integrated” or “done.”
12. **A reviewer protects the design goal.** Every nonempty isolated range is reviewed against the task plan using inclusive `root::content-tip`; the read-only reviewer classifies findings for the thinker.
13. **Review and repair are bounded.** Goal-blocking drift receives one automatic repair/re-review cycle; lesser findings are surfaced or deferred.
14. **Normal JJ rewriting is not failure.** Commit-ID changes and clean base rebases refresh evidence; ambiguous Change IDs, foreign writes, and unknown partial mutations stop affected writes.
15. **No-effect work is a first-class success.** Prove emptiness, remove the workspace safely, and close without synthetic history.
16. **The orchestration change is private and mutable, not immutable.** If `@` is empty and no `wip:` exists, deterministically create/describe one; never relabel unknown nonempty user work silently.
17. **Task plans are durable root context.** The thinker keeps concise Markdown state in its `wip:` change, snapshots relevant content into child packets, and refreshes from it before review.
18. **Models choose intent; deterministic tools perform JJ mutation.** Exact inclusive ranges, queues, topology checks, receipts, cleanup, squash, and verification belong in code.
19. **Owned conflicts are repairable.** Reviewer findings route through a bounded worker and deterministic squash while file locks remain held; ambiguous conflicts still stop mutation.
20. **No automatic publication or destructive recovery.** No push, bookmark creation, config mutation, broad abandon, force cleanup, or guessed rollback.
21. **Observability is hierarchical and bounded.** Active views omit terminal descendants; Inactive and inspect preserve summaries, lifecycle, findings, and once-only usage without feeding histories to parent models.
22. **Usage is root-scoped but attributable.** Totals retain provider/model, role, context, and execution-cycle breakdowns.
23. **Shared and isolated checkpoints are different.** Shared source uses `insert_change` plus locked `checkpoint_change`; an isolated workspace serializes writers and uses `workspace_checkpoint` to describe current `@`, create a fresh `@`, and record its Change ID.
24. **Restart preserves intent, not live locks.** File/workspace queues reset empty, interrupted claims are recorded, and resumed children reacquire before writing.
25. **Workspace bases may move explicitly.** `rebase_workspace` moves the verified root and all owned descendants onto an exact local base while preserving root/content-tip/head Change IDs and range membership; the root's parent is diagnostic.

## Ambiguities resolved by this design

| Question | Decision |
|---|---|
| Is a planner a general-purpose second thinker? | No. A planner always owns one substantial isolated workspace slice. |
| Does a planner only plan? | No. It owns planning and execution for its slice and may coordinate bounded workers. |
| Can a planner run in the main shared cwd? | No. Shared bounded implementation uses a worker; planning-only work remains with the thinker. |
| Can a worker create another writable worker? | No. Workers may delegate only read-only scouting or research. |
| Can the thinker keep working while children run? | Yes, only on independent work under explicit ownership boundaries. |
| Is read-before-write enough for parallel writers? | No. Shared writers also require canonical file-set queues and checkpoint/squash inside the lock. |
| Who owns a workspace after the child reports? | The thinker. The child owns writes while active; the thinker owns custody, review, integration, and closure. |
| Does `completed` mean a planner's work is merged? | No. It means ready for thinker acknowledgement and review. |
| Who curates history? | The planner curates before reporting; the thinker independently reviews and approves the exact range. |
| Can the thinker repair planner history after integration? | Not ad hoc. Cleanup and descriptions must be approved and deterministic before or as part of integration. |
| Must source `@` be clean? | No. The same private `wip:` Change ID and its content must be preserved. |
| What if a workspace has no effective changes? | Close it as `closed_no_changes` after an emptiness proof; create no commit. |
| What if a child context fails but leaves useful work? | End that execution cycle and preserve workspace custody for review or resumption. |
| Does abandoning a child delete its workspace? | No. Process lifecycle and workspace custody are separate. |
| Does a status request pause or finish work? | Neither. It reports a correlated snapshot and automatically resumes the prior activity. |
| Who is allowed to mutate JJ topology? | Deterministic tools under locks; models provide intent and semantic descriptions. |
| Does a parent need to poll or wait to hear from children? | No. Child events are pushed as custom messages. Awaiting is only an efficient barrier when the parent has nothing else to do. |
| Is a child a normal Pi session or subprocess? | No. It is a private in-process SDK context linked to the root and excluded from user session navigation. |
| Can a parent inspect child history? | No. It can read lifecycle metadata or request a bounded child-authored summary. |
| What does a changed shared-file fingerprint mean? | Before lock acquisition it means re-read and continue; while holding the lock it indicates an ownership bypass and stops that file mutation. |
| What if two workers need the same file? | They queue for the complete file set. Each edit and checkpoint/squash finishes before the next owner starts. |
| What identifies isolated work across rebases? | Stable root and expected workspace-head Change IDs, plus the frozen content tip reviewed as inclusive `root::content-tip`; commit IDs are observational only. |
| Who verifies the implementation still serves the spec? | A read-only reviewer compares the task-plan snapshot with the exact inclusive Change-ID range. |
| What happens on conflicts? | Owned, unambiguous conflicts enter one bounded reviewer→worker→squash→re-review cycle; foreign or ambiguous conflicts stop mutation. |
| What happens on crash or `/continue`? | The `/continue` prompt first reconciles children recursively; locks reset, resumed writers reacquire, and an unquiesced writer is never duplicated. |
| How does isolated work checkpoint? | `workspace_checkpoint` performs deterministic `jj commit` semantics and records old/new workspace-head Change IDs. |
| Can fetched trunk become the new workspace base? | Yes. After fetching separately, the thinker pauses writers and calls `rebase_workspace` onto source `@-` or an exact local Change ID. The tracked range stays the same; only its parent/base and commit observations may change. |
| Can an unexpected tracked Change ID be recovered? | Automatic mutation stops, but explicit user-authorized rebind/resume tools can adopt a verified replacement with an audit receipt. |

## Normative documents

- [Runtime model](RUNTIME_MODEL.md) — in-process Pi SDK child contexts, push messaging, resume, context boundaries, and usage.
- [Operating model](OPERATING_MODEL.md) — routing, role boundaries, ownership, review, and end-to-end workflows.
- [Blocking policy](BLOCKING_POLICY.md) — which conditions wait, refresh, reroute, repair, warn, or stop mutation.
- [Invariants and state machines](INVARIANTS.md) — authoritative states, transitions, receipts, and edge cases.
- [Agent and tool catalog](TOOLS.md) — complete tool contracts and role authority matrix.
- [Testing and eval strategy](TESTING.md) — Real-JJ E2E harness, SDK lifecycle tests, and prompt benchmarks.
- [Implementation DAG](IMPLEMENTATION_DAG.md) — dependency-ordered milestones and independently testable slices.
- [M0 foundation design](M0_DESIGN.md) — implemented strict types, JJ executor/Real-JJ fixture, SDK spike, and eval runner.
- [M1 implementation plan](M1_IMPLEMENTATION_PLAN.md) — accepted in-process child runtime, push protocol, wait/status, usage/compaction, and recursive recovery slices.
- [Implementation gaps](IMPLEMENTATION_GAPS.md) — provisional differences between the target model and current implementation.

Legacy context is available under [`../archive/`](../archive/README.md), but this subsystem design controls when the two disagree.
