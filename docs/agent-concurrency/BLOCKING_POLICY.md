# Blocking and continuation policy

The previous design was intentionally fail-stop, but some checks treated benign concurrency or normal JJ rewriting as corruption. This policy distinguishes conditions that must stop mutation from conditions that should wait, refresh, reroute, repair, warn, or continue.

## Dispositions

| Disposition | Meaning |
|---|---|
| Continue | State is expected and all required identities/ownership remain valid |
| Refresh | Re-read current state, recompute derived data, and continue without user involvement |
| Wait | Queue behind a known owner or event; do not fail |
| Reroute | Preserve current work and run a new bounded/isolated path instead |
| Repair | Enter a bounded, owned correction workflow followed by re-review |
| Warn/defer | Preserve a finding for the user without blocking the current goal |
| Ask user | Multiple safe semantic choices exist or destructive authority is required |
| Stop mutation | Continuing could corrupt, lose, misattribute, or publish work; read-only diagnosis may continue |

“Stop mutation” applies to the affected repository/workspace operation, not automatically to every child or the whole root session.

## Questionable invariants revised

### Shared worker path fingerprint changed

The earlier phrase meant: a worker inspected a file, another writer changed it, and the first worker's edit was now based on stale content. Treating every mismatch as a terminal invalid lease was too strict.

The target behavior is:

1. every writable file uses an in-process canonical file queue;
2. a worker waits for the complete requested file set;
3. after acquiring it, the worker re-reads current content;
4. it edits against that current content;
5. it runs the deterministic checkpoint/squash while still holding the set; and
6. it releases only after the feature boundary is recorded.

A pre-lock fingerprint mismatch is normal and causes a refresh, not an error. A mismatch **while the worker holds the lock** indicates an ownership bypass or external writer and stops mutation for those files.

### Two requested leases overlap

This means two workers request at least one common canonical path. It should normally queue, not throw.

For a shared-source multi-file task, acquire the complete path set atomically in canonical sorted order. This prevents deadlock and ensures the critical section is:

```text
acquire file set
→ re-read
→ edit
→ validate affected scope
→ checkpoint or squash
→ verify receipt
→ release file set
```

Thus overlapping tasks become `edit → squash → edit → squash`, never two edits followed by one ambiguous squash.

A long waiter may ask the thinker to reroute it to isolation. It must not begin partial writes while waiting for the rest of its set.

## JJ identity policy

### Change IDs, not commit IDs

Commit IDs are evidence for one observed version only. They may change after amend, rebase, descendant auto-rebase, conflict resolution, or description changes. A changed commit ID is never by itself a reason to stop.

Managed workspace identity is the inclusive Change-ID range:

```text
exactly(change_id(<root>), 1)::exactly(change_id(<content-tip>), 1)
```

`root::content-tip` includes both review boundaries. The workspace root and initial working head are captured at allocation; every `workspace_checkpoint` records the next expected working head; report freeze derives the last nonempty content tip. Review derives the interior from that range rather than treating a stored commit list as permanent identity.

### Benign base movement

Rebasing the development base onto a newer main line normally rewrites commit IDs while preserving Change IDs and auto-rebasing descendants. Continue when:

- root, expected workspace head, and content tip Change IDs still resolve uniquely;
- `root::content-tip` remains connected;
- no foreign head has entered the owned range;
- the per-change patches remain equivalent or are freshly reviewed;
- no unresolved conflict exists; and
- source/workspace ownership is unchanged.

The original base is useful diagnostic context, but an unchanged base Change ID, base commit ID, or exact original parent is not a blocking invariant. Every tracked root, workspace head, content tip, WIP, and inserted target lookup must still resolve exactly one result via `exactly(change_id(<id>), 1)`.

### Explicit workspace rebase

`rebase_workspace` is a manual semantic operation, not background normalization. It runs only after active workspace writers pause and the local target resolves exactly once. The operation rebases the verified root and all owned descendants together, including the expected empty workspace head. Fetching or bookmark movement is separate.

The root/content-tip/workspace-head Change IDs and exact range membership/order must remain unchanged. The root's parent/base Change ID is expected to change. A range-equivalent clean receipt continues; changed normalized patch evidence requests re-review; owned conflicts route to repair. Foreign descendants, divergent targets, or unquiesced writers stop before rebase.

### Review after a clean rebase

A clean rebase may invalidate commit hashes without invalidating semantic approval. Refresh the review receipt automatically when tracked Change IDs and normalized per-change patches are equivalent and there are no conflicts. Require focused re-review when patches changed. Do not enter `attention_required` merely because commit IDs changed.

An unexpected tracked Change ID stops automatic mutation, but common recovery is not forbidden. After bounded inspection, an explicit user instruction may authorize `rebind_tracked_change` or `resume_workspace_operation`. The recovery receipt records old/new identities and never rewrites history silently.

## Conflict policy

A JJ rebase can complete while recording conflicts in commits. A conflict is therefore a repair state, not automatically an unknown partial failure.

Use bounded automatic repair when all of the following hold:

- the conflicted revisions are uniquely identified and owned by the task;
- conflict files are inside an acquirable file set;
- no divergent Change ID, recovery commit, or foreign descendant is present;
- the intended squash target is unique; and
- the automatic review-repair budget is not exhausted.

Workflow:

```text
freeze reviewed range
→ rebase/integrate
→ detect conflicts
→ reviewer explains spec impact and target changes
→ thinker assigns bounded worker
→ acquire conflict file set
→ resolve in current WIP/resolution change
→ validate
→ deterministically squash each resolution into its owning change
→ verify no conflicts and all changes named/nonempty
→ focused reviewer pass
→ release file set
```

Stop mutation and ask the user when ownership or squash target is ambiguous, a conflict touches foreign work, a Change ID is divergent, or the correction budget is exhausted. Whether resolution was automatic or user-directed, the thinker emits a bounded conflict report listing affected paths/Change IDs, chosen worker and target, checkpoint/squash receipts, validation, reviewer outcome, and deferred concerns.

## Reviewer findings and loop budget

Every finding has two dimensions:

```ts
type FindingRelation = "introduced" | "in_scope_existing" | "out_of_scope_existing";
type FindingSeverity = "goal_blocking" | "high" | "medium" | "low" | "note";
```

| Severity | Examples | Default disposition |
|---|---|---|
| `goal_blocking` | Fundamental spec/design miss, acceptance criterion absent, data loss, critical security boundary failure, unresolved owned conflict | Repair immediately |
| `high` | Introduced correctness or security defect likely to cause material harm | One bounded repair if clearly in scope; otherwise ask user |
| `medium` | Localized bug, incomplete edge behavior, moderate hardening gap | Surface to user; repair only if cheap and explicitly within acceptance criteria |
| `low` | Minor robustness, maintainability, polish | Defer |
| `note` | Observation, pre-existing concern, optional improvement | Record only |

The automatic loop budget is one implementation repair plus one focused re-review per workspace. A second `goal_blocking` or `high` failure returns to the user unless the user explicitly authorizes another cycle. This prevents reviewer-driven infinite loops.

Out-of-scope existing findings never trigger automatic repair unless they create an immediate safety risk for the requested operation.

## Condition matrix

| Condition | Disposition | Rationale / next step |
|---|---|---|
| Child finishes while parent is active | Continue | Push a bounded custom child event at Pi's steer boundary |
| Parent has no independent work | Wait | `await_child_event` sleeps token-free; push wakes it |
| User talks while parent awaits | Continue immediately | Resolve only `await_child_event` before normal Pi steering; children keep running |
| Root turn is aborted/cancelled | Continue child work | Root-turn control does not imply child cancellation |
| `cancel_child` targets one active cycle | Cancel that cycle | Preserve context/workspace custody; do not auto-resume cancelled cycle |
| Recursive child cancellation explicitly requested | Cancel selected subtree post-order | Do not affect unrelated siblings |
| Child status metadata requested | Continue | Read coordinator state only |
| Fresh semantic status requested | Continue | Ask child for bounded summary; resume prior activity |
| Child transcript requested by parent model | Stop that access | Request a summary instead; preserve context boundary |
| Root process restarted | Refresh | Clear live waits/lock ownership/queue positions, reconcile descendants post-order, recreate resumable contexts, and require reacquisition |
| Child SDK run crashed | Refresh/retry | Start linked replacement cycle after proving old mutation quiescent |
| Child appears quiet | Continue | Quiet is not hung; request status after role-specific deadline |
| Child is unresponsive but abort settles | Refresh/retry | Recreate one writer from durable state |
| Old writer cannot be proved quiescent | Stop affected writes | Never duplicate a writer |
| Shared-source file set is held by another worker | Wait | FIFO queue or optional reroute to isolation |
| File changed before lock acquisition | Refresh | Re-read and edit current content |
| File changed while lock held | Stop affected writes | Indicates lock bypass/external mutation |
| Requested file sets overlap | Wait | Serialize complete edit/checkpoint critical sections |
| Scope expands to an unlocked file | Wait/reroute | Acquire a new complete set before writing or isolate |
| Shared change cannot be cleanly checkpointed | Reroute | Preserve state and move a new correction task to isolation; do not guess |
| No orchestration WIP exists and `@` is empty | Continue | Deterministically describe/create `wip: thinker workspace` or configured `private:` equivalent |
| No orchestration `wip:` exists and `@` is nonempty | Ask/normalize | Do not relabel unknown user work without review |
| Private selector missing | Warn | Explain config; do not edit it |
| WIP is immutable | Stop WIP mutation | Explain config; read-only work may continue |
| Workspace base commit IDs changed | Continue | Commit IDs are not identity |
| User requests workspace rebase to local source `@-` or exact Change ID | Continue after pause | Acquire workspace token/repository mutex and move exact owned descendants together |
| Workspace root parent/base Change ID changed with rebase receipt | Continue | Base is diagnostic; verify unchanged root/head/content-tip and range membership |
| Workspace rebase is range-equivalent and conflict-free | Refresh | Preserve or refresh matching review evidence |
| Workspace rebase changes normalized owned patch | Re-review | Range identity remains valid but prior semantic approval is stale |
| Workspace rebase records owned conflicts | Repair | Preserve custody and route bounded conflict workflow |
| Workspace rebase target is divergent/foreign or writer is active | Stop affected rebase | Do not guess target or move an active workspace |
| Root/head/content-tip remain unique and connected | Continue | Resolve each exactly once and use inclusive `root::content-tip` |
| Recorded workspace head changes with a `workspace_checkpoint` receipt | Continue | Adopt receipt's `newHeadChangeId` |
| Tracked Change ID changes without a receipt | Stop automatic mutation | Inspect; user may explicitly authorize verified rebind/resume |
| Root/head/tip Change ID is divergent | Stop mutation | Identity is ambiguous |
| Root no longer reaches tip because planner intentionally rewrote history | Refresh/review if a durable tool receipt explains it; otherwise stop | Never infer a replacement boundary |
| Reported tip gained known deterministic rewrites | Refresh | Update receipt if patch-equivalent |
| Reported tip changed from unknown writer | Stop workspace writes | Re-review ownership before continuing |
| Stale workspace without recovery | Refresh | `workspace update-stale`, then revalidate |
| Stale update creates recovery commit | Stop mutation | Recovery introduces unowned state |
| Rebase records owned conflicts | Repair | Reviewer → bounded worker → squash → focused review |
| Conflict touches foreign/unowned work | Ask user | Ownership is ambiguous |
| Empty interior changes | Refresh/normalize | Remove exact safe empties while preserving root anchor |
| Unnamed nonempty changes | Repair before approval | Semantic owner supplies names; deterministic tool applies them |
| Entire range is empty | Continue | Close `closed_no_changes` |
| Workspace directory cleanup fails after verified integration | Warn/cleanup pending | Semantic result can remain complete; retry exact cleanup later |
| Known integration phase completed before process crash | Refresh/resume | Verify receipt and continue from next idempotent phase |
| Mutation phase cannot be reconstructed | Stop mutation | Preserve operation log and ask user |
| Reviewer finds goal-blocking drift | Repair | One automatic bounded cycle |
| Reviewer finds minor or out-of-scope issue | Warn/defer | Surface in final report |
| Verification fails for unrelated flaky check | Retry boundedly/warn | Distinguish infrastructure from implementation failure |
| Verification proves requested behavior wrong | Repair or ask | Apply loop budget and severity policy |
| Usage log missing but lifecycle is recoverable | Continue with accounting warning | Side ledger remains authoritative; do not fabricate data or block code work solely for telemetry |
| Clean objective closes with all receipts durable | Cleanup | Delete exact raw private journals; retain bounded reports/events/receipts/usage |
| Child is blocked/incidented or workspace custody unresolved | Retain | Private journal remains recovery evidence |

## Conditions that remain hard mutation stops

Only these classes are inherently blocking for the affected mutation:

1. **Ambiguous identity:** divergent/non-unique Change IDs or unexplained replacement root/head/content-tip, unless an explicit user-authorized rebind proves a unique owned replacement.
2. **Unowned writes:** a file changes inside a held critical section or foreign work enters an owned range.
3. **Unknown partial mutation:** completed boundaries cannot be reconstructed from JJ operation state and receipts.
4. **Unquiesced duplicate writer risk:** old child/tool may still mutate while replacement would start.
5. **Unresolvable authority:** destructive disposal, publication, config mutation, or semantic conflict choice lacks user authorization.
6. **Critical review failure after budget:** continuing would knowingly violate the goal or a critical safety boundary.

Everything else should preferentially refresh, wait, reroute, repair, warn, or ask rather than crashing the entire concurrency subsystem.
