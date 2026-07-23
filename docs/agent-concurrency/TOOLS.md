# Agent and tool catalog

This is the consolidated tool surface for the target concurrency model. Names are design-level names; implementation may preserve compatibility aliases temporarily, but each authority and invariant should remain distinct.

## Principles

1. Models choose intent, scope, semantic descriptions, and findings.
2. Deterministic tools choose exact JJ revsets, mutation order, locks, receipts, and postcondition checks.
3. A tool handler receives opaque tracked handles/leases from its execution context and constructs exact expressions itself. Model-visible inputs do not include cwd, tracked Change IDs, revsets, filesets, or JJ arguments unless choosing a bounded semantic scope genuinely requires one.
4. Every mutating tool is scoped to an owner context and workspace.
5. Read-only inspection tools return bounded projections, never complete histories or unbounded diffs into a parent context.
6. Parent/child protocol messages are custom Pi messages, not user messages.
7. Checkpoint and squash tools retain the full file-set lock until the JJ receipt verifies success.

## JJ capability boundary

Model tools call strong internal `JjOperations` capabilities. The operation receives a tracked source/workspace handle, file-set claim, writer lease, or approved integration handle injected by the harness. That private handle resolves the small known set of managed working-copy paths and expected Change IDs.

For example, the model-facing isolated checkpoint input is only:

```ts
{ description: string }
```

The handler injects `IsolatedWorkspaceWriteLease`; `checkpointWorkspace(lease, { description })` loads and verifies the expected head internally. Shared `checkpoint_change` similarly consumes the active `CheckpointableFileSetClaim`, including its assigned target and complete file set, instead of accepting those values from model text.

`JjOperations` constructs behaviorally meaningful steps over a repository-scoped executor; a lower `JjProcessExecutor` alone converts trusted argv into a bounded `jj` process invocation. Neither executor is model-visible.

## Agents

| Agent | Purpose | Writable scope | May create children | Workspace authority |
|---|---|---|---|---|
| Thinker | Own user intent, task plan, routing, review decisions, integration, and final verification | Main workspace under file-set locks | Planner, worker, reviewer, scout, researcher | Create, review, integrate, verify, close |
| Planner | Own one substantial isolated slice and its internal decomposition | Its isolated workspace under one workspace-wide writer token | Worker, scout, researcher | No create/integrate; may checkpoint, prepare, and normalize its owned range |
| Worker | Implement one bounded assignment | Assigned file set and feature Change ID, or whole bounded isolated workspace | Scout, researcher only | No workspace lifecycle authority |
| Reviewer | Verify a spec/task plan against an inclusive Change-ID range | Read-only | Scout, researcher | Read-only range/conflict inspection |
| Scout | Fast repository reconnaissance | Read-only | None | None |
| Researcher | Repository and external research | Read-only | None | None |

The reviewer never directly launches a repair worker. It reports findings to the thinker, which decides whether the severity and loop budget authorize repair.

## Role-to-tool matrix

Legend: **●** available, **○** available only when the role owns an appropriate shared/isolated change, **—** unavailable. Child protocol tools are injected into child contexts.

| Tool | Thinker | Planner | Worker | Reviewer | Scout | Researcher |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `read` | ● | ● | ● | ● | ● | ● |
| `write` / `edit` | ● | ● | ● | — | — | — |
| `grep` / `find` / `ls` | ● | ● | ● | ● | ● | ● |
| constrained `bash` | ● | ● | ● | ● | read-only | read-only |
| `web_search` / `web_fetch` | ● | ● | — | ● | — | ● |
| `update_plan` | ● | ● | ○ | — | — | — |
| `task_plan` | ● | read snapshot | read snapshot | read snapshot | — | — |
| `spawn_child` | ● | ● | ● read-only children | ● read-only children | — | — |
| `spawn_workspace_child` | ● | — | — | — | — | — |
| `message_child` | ● | ● | ● | ● | — | — |
| `child_status` | ● | ● | ● | ● | — | — |
| `request_child_status` | ● | ● | ● | ● | — | — |
| `request_child_summary` | ● | ● | ● | ● | — | — |
| `await_child_event` | ● | ● | ● | ● | — | — |
| `ack_child_event` | ● | ● | ● | ● | — | — |
| `cancel_child` | ● | ● | ● | ● | — | — |
| `reconcile_children` | ● | ● | ● | ● | — | — |
| `message_parent` | root has no parent | ● | ● | ● | ● | ● |
| `acquire_file_set` | ○ shared source | — | ○ shared source | — | — | — |
| `release_file_set` | ○ shared source | — | ○ shared source | — | — | — |
| `jj_concurrency_status` | ● | ● | ● | ● | read-only basic | read-only basic |
| `ensure_wip_change` | ● | — | — | — | — | — |
| `insert_change` | ● | — | — | — | — | — |
| `checkpoint_change` | ○ shared source | — | ○ assigned shared change | — | — | — |
| `workspace_checkpoint` | — | ● | ○ isolated only | — | — | — |
| `prepare_workspace_report` | — | ● | ○ isolated only | — | — | — |
| `inspect_change_range` | ● | ● | ● bounded | ● | — | — |
| `inspect_conflicts` | ● | ● | ● bounded | ● | — | — |
| `normalize_change_range` | ● | ● own range | — | — | — | — |
| `integrate_workspace` | ● | — | — | — | — | — |
| `squash_resolution` | ● | ● own workspace | ○ assigned target | — | — | — |
| `verify_integrated_range` | ● | — | — | ● read-only evidence | — | — |
| `close_workspace` | ● | — | — | — | — | — |
| `rebind_tracked_change` | ● user-authorized | — | — | — | — | — |
| `resume_workspace_operation` | ● user-authorized | — | — | — | — | — |
| `retry_workspace_cleanup` | ● | — | — | — | — | — |
| `concurrency_usage` | ● | ● subtree | ● subtree | ● subtree | own | own |

## Built-in and constrained tools

### `read`, `grep`, `find`, `ls`

Normal Pi tools. Parent models may inspect repository files, task plans, and deterministic review artifacts. They may not point these tools at managed child context journals or transcripts.

### `write` and `edit`

Writable roles use wrapped Pi tools that require an active file-set lock covering the canonical target path. They reuse Pi's exported `withFileMutationQueue()` internally. In a shared workspace, a write without the covering lock is rejected before filesystem mutation.

### Constrained `bash`

- JJ mutation subcommands are denied; use deterministic JJ tools.
- Shared workers cannot use shell commands whose purpose is direct file mutation.
- Validation commands may write declared build/cache outputs but not source files.
- Reviewer/scout/researcher shell use is read-only except for isolated temporary test artifacts.

### `update_plan`

Maintains the current context's short execution checklist. It is not the durable cross-context task specification.

## Task-plan tool

### `task_plan`

Thinker-owned durable Markdown state for a user objective.

```ts
type TaskPlanAction =
  | { action: "create"; objective: string; acceptanceCriteria: string[]; decisions: string[] }
  | { action: "update"; planId: string; patch: TaskPlanPatch }
  | { action: "read"; planId: string }
  | { action: "snapshot"; planId: string }
  | { action: "close"; planId: string; outcome: string };
```

The tool writes one concise managed Markdown file in a configured repository plan directory and returns its path/hash. The exact directory remains a product configuration decision; it must be repository-visible because the thinker wants it in the `wip:` orchestration change.

Before child launch, `snapshot` stores the relevant bounded plan content/hash in the delegation record. A workspace child does not depend on reading source `@`, because its workspace still branches from source `@-`. Before review, the thinker may reread the plan file to refresh root context; the reviewer receives the snapshot plus any explicitly approved plan update.

## Parent/child protocol tools

### `spawn_child`

Starts an in-process managed child context in the caller's cwd. Inputs include role and self-contained task packet. It returns immediately with child/context IDs; completion arrives by pushed custom message.

- Thinker: worker, reviewer, scout, researcher.
- Planner: worker, scout, researcher.
- Worker: scout, researcher only.
- Reviewer: scout, researcher only.

Planner launch is intentionally excluded; planners use `spawn_workspace_child`.

### `spawn_workspace_child`

Atomic thinker-only operation:

1. validates JJ readiness and source WIP identity;
2. allocates a unique workspace name/path;
3. creates the workspace from source `@-`;
4. captures source workspace, source WIP Change ID, diagnostic base Change ID, workspace name/path, root Change ID, and initial workspace-head Change ID (the same ID at allocation);
5. verifies every tracked Change ID resolves with `exactly(change_id(<id>), 1)` and source content was untouched; and
6. starts an in-process planner or isolated worker context bound to that cwd.

If child startup fails, workspace custody remains durable and explicit. The tool never silently falls back to a normal child.

### `message_child`

Sends a custom parent message. It supports instruction, question response, review feedback, and continuation payloads. It never appears as a user message.

### `message_parent`

One child protocol tool with a strict discriminated input:

```ts
type ParentMessage =
  | { kind: "question"; question: string; options?: string[]; recommendation?: string }
  | { kind: "status"; requestId: string; summary: BoundedStatusReport }
  | { kind: "result"; outcome: "completed" | "blocked" | "failed"; report: BoundedChildReport }
  | { kind: "review"; report: ReviewerReport };
```

`result` is rejected while direct children remain unresolved or unacknowledged. `status` never changes lifecycle.

### `child_status`

Reads coordinator metadata only: role, objective, lifecycle, heartbeat, resume point, file queue, workspace/review phase, and latest bounded report availability. It never reads or summarizes a child history.

### `request_child_status`

Sends a correlated request for the child's standard bounded status summary. It may wait for the matching report or return a request ID for pushed delivery. A timeout leaves the child running.

### `request_child_summary`

Requests bounded details about a specific topic without exposing history. Inputs include child ID, focus/question list, and a response token cap. The child answers from its own context as a custom message, then resumes its saved activity. This is the escape hatch when the standard status or terminal report is insufficient.

### `await_child_event`

Token-free wait-any barrier. Wakes for one direct-child question or terminal report. While this exact tool is active, an interactive user input hook immediately cancels/resolves the wait before allowing Pi's normal user-message steering path, so the message cannot remain queued behind the child wait. Children are untouched. Outside this tool, Pi's default queue/steer behavior is unchanged.

### `ack_child_event`

Acknowledges one event ID, advances terminal collection state when appropriate, and imports its usage receipt exactly once. It returns only the bounded report and structured metadata already represented by the event—not history.

### `cancel_child`

Cancels a child execution tree. It does not dispose workspace custody or delete feature changes. Cancellation waits for file/JJ mutation critical sections to settle.

### `reconcile_children`

Rebuilds missing safe resumable child contexts from durable journals. `/continue`, root resume, and delegating-child resume call this automatically; the tool also permits explicit diagnosis. It refuses to duplicate an unquiesced writer. Restart clears in-memory file/workspace lock ownership, marks old claims interrupted, and requires every resumed writer to reacquire before mutation.

## File-set coordination tools

### `acquire_file_set`

Requests an atomic canonical set of source paths for one owner and feature Change ID.

- Existing files canonicalize through realpath; new paths use normalized absolute paths.
- Equal and ancestor/descendant aliases collide.
- Sets are registered in canonical sorted order.
- An overlapping request waits FIFO rather than throwing.
- No partial subset is granted.
- After acquisition, the caller must re-read every target it intends to edit.

The receipt contains lock ID, canonical paths, owner context, workspace, feature Change ID, and acquisition time.

### `release_file_set`

Releases an unused or safely checkpointed shared-source set. It rejects release when the owner has uncheckpointed source changes in that set. `checkpoint_change` normally releases automatically after receipt verification.

## JJ readiness and WIP tools

### `jj_concurrency_status`

Read-only bounded inspection:

- repo/workspace identity;
- `@` and parent Change IDs and observed commit IDs;
- description, emptiness, conflicts, and mutability;
- detected orchestration `wip:` identity;
- `git.private-commits` diagnostic;
- managed workspaces, feature targets, and mutation lock state;
- stale/recovery/divergence diagnostics.

Commit IDs are displayed as observed versions, never used as durable ownership keys.

### `ensure_wip_change`

Thinker-only main-workspace normalization.

- If current `@` is already the recorded WIP Change ID, verify and return it.
- If no WIP exists and `@` is empty, deterministically describe that working change as `wip: thinker workspace` (or a configured `private:` equivalent) or create a fresh empty WIP when required by topology.
- If current `@` is nonempty unknown user work, return a decision request instead of relabeling or rewriting it.
- Warn when private protection is missing.
- Stop WIP mutation if the target is immutable; never use `--ignore-immutable` automatically.

### `insert_change`

The thinker supplies semantic description and assigned owner; its tracked source handle is injected. It does not supply a target Change ID, cwd, or insertion revset. The operation creates a named empty change immediately before a recorded WIP while preserving the WIP Change ID and content. Its description makes the shared-workspace purpose explicit. It returns:

- inserted Change ID;
- source WIP Change ID;
- assigned owner context ID;
- description;
- parent Change IDs before/after; and
- JJ operation ID.

Every tracked ID is resolved with `exactly(change_id(<id>), 1)`. This inserted change is the only target that the assigned shared worker may checkpoint into.

### `checkpoint_change`

The handler injects the caller's active checkpointable file-set claim; the model does not resubmit target Change ID, cwd, paths, fileset, or revset. The operation moves only the claim's locked shared-source file set from WIP into its assigned inserted Change ID.

Preconditions:

- caller owns the inserted target;
- lock ID covers every selected path;
- source WIP and target each resolve to exactly one change;
- target is mutable; and
- no unowned path is included.

The tool constructs the exact JJ fileset/revset, performs squash, verifies unrelated WIP content and WIP Change ID are preserved, checks conflicts, records a receipt, and releases the file set. Failure keeps the lock until state is diagnosed or explicitly handed off.

### `workspace_checkpoint`

The model supplies only a nonempty semantic `description`; the handler injects its current isolated-workspace writer lease. The only routine checkpoint tool available to an isolated planner/worker. Isolated workspaces serialize writers with a workspace-wide write token rather than shared-source file sets.

This tool provides deterministic `jj commit` semantics:

1. require the workspace's current `@` Change ID to equal the recorded workspace head via `exactly(change_id(<head>), 1)`;
2. require a nonempty semantic description;
3. describe the current change and create a fresh empty working-copy change on top as one managed operation;
4. verify the checkpointed Change ID is unchanged and named;
5. capture the new working-copy head Change ID;
6. verify the old head is the new head's parent and neither is divergent; and
7. persist the head transition and JJ operation ID before releasing the workspace write token.

The receipt contains `checkpointedChangeId`, `previousHeadChangeId`, `newHeadChangeId`, description, parents, conflicts, and operation ID. Any unreceipted change to the tracked workspace head stops automatic workspace writes. A later user-authorized `rebind_tracked_change` may adopt a verified replacement.

## Workspace range and review tools

### `prepare_workspace_report`

Planner or isolated-worker pause boundary:

1. requires every direct child terminal and acknowledged;
2. waits for the workspace write token and JJ mutation to settle;
3. requires current `@` to equal the recorded workspace-head Change ID exactly;
4. captures both the working head and last nonempty content tip (the parent when the head is the expected empty post-checkpoint change);
5. constructs the inclusive `root::content-tip` range;
6. reports empty, unnamed, conflicted, and divergent state; and
7. freezes the workspace against further writes.

It returns a report receipt. It does not integrate.

### `inspect_change_range`

Read-only tool for thinker, reviewer, and scoped owners. Input is `rootChangeId` and `contentTipChangeId`; code constructs:

```text
exactly(change_id(<root>), 1)::exactly(change_id(<content-tip>), 1)
```

Output is bounded per-change metadata, normalized patch summaries, cumulative diff hash, changed paths, descriptions, emptiness, conflicts, and foreign-head diagnostics. Large diffs are stored as non-context artifacts and read selectively.

The reviewer receives the canonical revset string in its task packet, but mutating tools never accept arbitrary model-authored revsets.

### `inspect_conflicts`

Focused read-only conflict projection for an exact inclusive range. Returns conflicted Change IDs, paths, owning feature targets, conflict sides/markers through bounded artifacts, and candidate deterministic squash targets. It performs no resolution.

### `normalize_change_range`

Planner on its owned workspace or thinker under custody. Given root/workspace-head/content-tip and semantic descriptions:

- preserves the root anchor until integration/no-effect closure;
- removes exact safe empty interior changes;
- preserves the expected empty workspace head while the workspace still targets it, excluding it from the review range;
- applies descriptions to every retained nonempty change;
- verifies the resulting inclusive range, order, and no foreign descendants; and
- returns old/new tip and operation receipts.

It cannot invent descriptions. Missing semantic names are returned to the planner/thinker.

## Integration and repair tools

### `integrate_workspace`

Thinker-only and review-receipt-gated. It:

1. acquires the repository JJ mutation mutex;
2. refreshes stale metadata and tolerates commit-ID-only rewrites;
3. revalidates unique root/workspace-head/content-tip Change IDs and normalized patch evidence;
4. captures recovery identities;
5. at the recorded forget boundary, removes the expected empty workspace head plus approved interior empties and integrates the retained content range before source WIP;
6. records known phase boundaries;
7. checks conflicts, ancestry, names, emptiness, and source WIP content preservation; and
8. returns integrated root/content-tip, prior workspace head, conflict state, operation IDs, and workspace cleanup state.

Owned conflicts return `conflict_resolution_required`; they are not collapsed into unknown failure. Divergence, foreign work, recovery commits, or unprovable partial mutation stop affected JJ mutation.

### `squash_resolution`

Used by a bounded worker after reviewer findings. It requires a conflict file-set lock and exact target Change ID. The worker resolves in the current WIP/resolution change; the tool squashes only those locked paths into the target, verifies the target remains in the owned inclusive range, checks that the conflict is gone, records a receipt, and releases the lock.

It cannot target a foreign or ambiguous change. Multiple target changes require separate locked resolve/squash receipts.

### `verify_integrated_range`

Read-only graph verification against the integration/review receipts:

- source WIP Change ID/content preserved;
- integrated root/content-tip uniquely connected and prior workspace head accounted for;
- every retained change named and nonempty;
- no unresolved conflicts;
- no unapproved change entered the range;
- expected parent/ancestry relation holds after benign rebases.

Product acceptance checks remain thinker/reviewer work; this tool verifies JJ invariants.

### `close_workspace`

Final thinker-only custody transition.

- `closed`: requires integration and product verification receipts.
- `closed_no_changes`: requires empty-range proof.
- `cleanup_pending`: semantic work is complete but exact directory/runtime cleanup remains retryable.
- disposal of nonempty unintegrated work requires explicit user authority.

## Explicit recovery tools

Unexpected tracked Change IDs stop automatic mutation, but they do not make common recovery impossible. Recovery is a separate user-authorized operation with its own receipt.

### `rebind_tracked_change`

After `jj_concurrency_status`/range inspection, rebinds one managed WIP, workspace head, root, tip, or inserted checkpoint target to a user-approved Change ID. It does not rewrite JJ. It verifies the replacement resolves exactly once, is in the expected repository/workspace, preserves required ancestry/ownership, and records old/new IDs plus the authorizing user event.

This tool is unavailable for silent model recovery. Divergent IDs or foreign ranges remain unrebindable until the user resolves the ambiguity outside the automatic path.

### `resume_workspace_operation`

Resumes only the next idempotent phase of a previously interrupted workspace operation when persisted receipts and current JJ state prove every preceding boundary. It cannot skip phases, repeat an unproved mutation, or roll back.

### `retry_workspace_cleanup`

Retries only exact recorded cleanup work such as removing a forgotten workspace directory or disposable runtime artifact. It cannot discard nonempty tracked changes or alter graph history.

## Usage tool

### `concurrency_usage`

Returns bounded root/subtree usage without reading histories:

- total input/output/cache tokens and cost;
- provider/model breakdown;
- role breakdown;
- child-context and execution-cycle breakdown;
- unattributed/missing telemetry warnings.

The ledger sums immutable intrinsic usage events once. Parent acknowledgement marks attribution but does not duplicate descendant usage.

## Tools intentionally absent

- Arbitrary mutating `jj` shell tool.
- Read-child-history or enter-child-session tool.
- Nested workspace creation for planner/worker/reviewer.
- Automatic push/bookmark/configuration tool.
- Generic “repair JJ” or rollback tool.
- Force-remove workspace tool.
- Reviewer-to-worker direct delegation.
- Tool that accepts an unrestricted mutating revset.

These omissions are part of the authority model, not missing convenience features.
