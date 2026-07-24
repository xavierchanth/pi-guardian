# Agent concurrency operating model

## 1. System boundary

The concurrency subsystem receives a user objective and coordinates zero or more child agents. Its output is one of:

- a verified inline result;
- a set of reviewed, integrated, and verified feature changes;
- a proved `closed_no_changes` result;
- a user decision request; or
- an `attention_required` handoff with preserved state and diagnostics.

The subsystem owns child-context records, file-set coordination, workspace custody, event acknowledgement, JJ mutation tools, review receipts, recursive usage accounting, and concurrency UI. It does not own publishing, remote branches/bookmarks, user JJ configuration, or destructive recovery.

## 2. Execution lanes

There are three lanes. The thinker selects exactly one lane per writable task slice before work starts.

| Lane | Use when | Writers | JJ shape |
|---|---|---|---|
| Inline | Small and sequential; delegation would cost more than it saves | Thinker | Main `wip:` orchestration change, followed by deterministic feature checkpoint when material |
| Shared | Bounded task with a known whole-file set | Thinker and queued workers | Same orchestration change; each file-set critical section includes edit and checkpoint/squash |
| Isolated | Substantial, parallel, overlap-prone, uncertain, or explicitly isolated work | One planner or worker and its queued helpers | New JJ workspace rooted at recorded source `@-` |

Read-only scouts, researchers, and reviewers may run concurrently because they never acquire write ownership.

### Routing algorithm

1. If the work is read-only evidence gathering, use a scout or researcher.
2. If it is small enough for the thinker to finish without losing orchestration context, work inline.
3. If it is bounded implementation and its writable file set is known, use a shared worker; overlapping sets queue rather than fail.
4. If it needs decomposition, use an isolated planner.
5. If it is bounded but isolation is requested or ownership is uncertain, use an isolated worker.
6. If slices are independent, create one isolated workspace per slice.
7. If slices depend on the same evolving code, keep them sequential under one planner or thinker rather than manufacturing parallelism.
8. After any nonempty isolated implementation pauses, launch a reviewer for its exact range. Review of inline/shared quick work is optional unless risk or acceptance criteria warrant it.
9. If scope expands after launch, checkpoint the current locked set first, then acquire the expanded set or reroute a new task to isolation.

## 3. Role contract

### Responsibility matrix

| Responsibility | Thinker | Planner | Worker | Reviewer | Scout | Researcher |
|---|---:|---:|---:|---:|---:|---:|
| Own user intent and final response | Yes | No | No | No | No | No |
| Select execution lane | Yes | Within its existing workspace only | No | No | No | No |
| Create/integrate/close JJ workspaces | Yes | Never | Never | Never | Never | Never |
| Decompose a substantial feature slice | Top-level boundaries | Yes, within assigned slice | No | No | No | No |
| Implement | Small/direct work | Yes | Yes | Never | Never | Never |
| Launch writable children | Shared/isolated worker; isolated planner | Shared worker in planner cwd | Never | Never | Never | Never |
| Launch read-only children | Yes | Yes | Yes | Scout/researcher | Never | Never |
| Curate feature history | Final authority | Own workspace before report | Own assigned change | Never | No | No |
| Verify plan/spec against exact range | Own decision | Self-check | Self-check | Independent specialist | No | Evidence only |
| Integrate and verify source | Yes | No | No | Read-only evidence | No | No |
| Ask the user | Yes | Ask parent | Ask parent | Report finding | Report uncertainty | Report uncertainty |

### Thinker

The thinker is the sole orchestration authority and workspace custodian. It:

- converts user intent into coherent task slices;
- chooses inline, shared, or isolated execution;
- allocates shared-source file sets, inserted Change IDs, and isolated workspaces;
- continues only independent work while children run;
- receives pushed bounded child events and explicitly acknowledges them;
- answers questions and issues custom-message steering;
- refreshes from the durable task-plan Markdown when root context is stale;
- commissions a reviewer for every nonempty isolated Change-ID range;
- requests corrections when review fails;
- serializes integration and shared checkpoints;
- verifies the integrated product state; and
- closes every delegation and workspace before claiming completion.

The thinker may implement small work. It should not create a planner merely to avoid making a design decision, and it must not redo a child's active assignment inline.

### Planner

A planner always owns one substantial isolated slice. This removes the ambiguity between a “planner” and a second root thinker.

A planner:

- receives a workspace and a self-contained slice contract;
- investigates and decomposes only that slice;
- may implement directly;
- may launch bounded shared workers and read-only specialists inside its workspace;
- serializes writable workers behind the isolated workspace's single write token;
- acknowledges all direct-child reports;
- validates the complete slice;
- curates its owned JJ history into meaningful named changes;
- leaves a stable recorded workspace head and last nonempty content tip with no unexplained residue; and
- reports the exact validation, changed paths, range, and concerns.

A planner never creates or integrates a workspace, changes the source workspace, publishes, or reports the user's overall request as complete. Its terminal `completed` outcome means **ready for thinker review**.

### Worker

A worker owns bounded implementation with predetermined acceptance criteria. It does not perform open-ended product decomposition.

- A shared-source worker receives an atomic canonical file-set claim and assigned inserted Change ID.
- An isolated worker receives the whole isolated workspace for a bounded task and serializes behind its workspace-wide write token.
- A worker may launch scouts or researchers, but not another writable worker.
- It reads before writing, revalidates before edits after waits, validates its result, and reports exact changed paths and concerns.

If the task expands beyond its boundary or needs a second writer, the worker asks its parent rather than widening its own authority.

### Reviewer

A reviewer is a read-only child of the thinker. It receives:

- the bounded task-plan snapshot and acceptance criteria;
- workspace root, expected workspace-head, and content-tip Change IDs;
- the canonical inclusive `root::content-tip` revset;
- planner validation and changed-path summary; and
- deterministic range/conflict inspection tools.

It explores the implementation and may use scouts/researchers, but never writes or launches a repair worker. It reports structured findings with relation and severity. The thinker owns repair routing and the one-cycle automatic review budget.

### Scout and researcher

Both are read-only. A scout gathers repository evidence. A researcher may additionally gather current external evidence. Neither mutates files, delegates, or claims implementation completion.

## 4. Ownership model

### Task ownership

Every child receives a self-contained packet with:

- objective;
- context and relevant prior decisions;
- exact resources;
- writable scope or explicit read-only status;
- constraints and forbidden operations;
- acceptance criteria;
- expected report shape; and
- uncertainty behavior.

No child inherits conversation history. Each child is a private in-process Pi SDK context. Authority comes from the packet, role snapshot, assigned shared Change ID or workspace head, active coordination token, and deterministic tools—not from filesystem access alone.

### File-set queues

Every shared-cwd writer requests its complete canonical file set before mutation. Pi-Tai extends Pi's in-process per-file mutation queue so the lock remains held across the semantic boundary:

```text
acquire complete set
→ re-read current files
→ edit
→ validate affected scope
→ checkpoint/squash into assigned Change ID
→ verify receipt
→ release complete set
```

Rules:

1. Equal and ancestor/descendant paths collide; overlapping requests wait FIFO rather than fail.
2. Multi-file sets are acquired atomically in canonical order, so a worker never edits under a partial grant.
3. Shared ownership is whole-file initially, not model-authored hunk ownership.
4. A pre-lock content change is normal: the next owner re-reads and continues.
5. A change observed while the lock is held indicates an ownership bypass and stops affected writes.
6. A path containing pre-existing unowned orchestration edits cannot be checkpointed by guessing; checkpoint known work first or reroute.
7. Scope widening happens only after the current set is checkpointed/released, then a new union is acquired.
8. A terminal report cannot release a set with uncheckpointed changes.

### Workspace custody

An isolated workspace has one root owner context and one custodian: the thinker. The planner or worker may modify it while active, but cannot dispose of or integrate it. Ending or cancelling a child execution cycle does not imply workspace deletion.

Isolated workspaces use a different checkpoint model from the shared source: exactly one writable planner/worker holds a workspace-wide write token, edits current `@`, and calls `workspace_checkpoint` before releasing it. `workspace_checkpoint` deterministically describes current `@`, creates a fresh empty `@`, and records the new workspace-head Change ID. Read-only children may still run concurrently. Inner workers do not become workspace custodians and cannot create nested workspaces.

## 5. Main JJ workspace model

### Orchestration change

The main workspace keeps one mutable orchestration change:

```text
named feature changes
└── wip: thinker workspace   ← main workspace @
```

The `wip: thinker workspace` change (or configured `private:` equivalent) is a private dumping ground for the thinker, concise task-plan Markdown, and shared-lane work. The text is a description; the separately recorded JJ Change ID is its identity. It is mutable by policy. If no orchestration change exists and current `@` is empty, `ensure_wip_change` deterministically describes or creates it. Unknown nonempty user work is never silently relabeled.

Recommended user configuration:

```toml
[git]
private-commits = "description('wip:*') | description('private:*')"
```

Pi-Tai checks for missing protection and explains the risk. It inherits user/repository JJ configuration so identity, signing, immutability, and related policy remain active, but never edits that configuration. Managed commands use built-in command names and explicit long-form options. Pi-Tai does not create bookmarks, push, or otherwise publish.

### Task-plan Markdown

The thinker keeps one concise managed Markdown plan per substantial user objective in the orchestration change. It contains the goal, acceptance criteria, decisions, slices, root/workspace-head/content-tip Change IDs, review state, and deferred findings. Before launching a child, Pi-Tai snapshots the relevant bounded content/hash into the child's packet because isolated work still branches from source `@-` and therefore does not inherit files present only in source `@`. Before review, the thinker can reread the plan rather than child history.

### Shared-source checkpoints

`insert_change` creates and records a named empty Change ID immediately before the same orchestration Change ID. The assigned worker edits under a file-set lock, and `checkpoint_change` squashes only that set into the assigned target before releasing the lock. The receipt records:

- orchestration Change ID before and after;
- feature Change ID and description;
- exact locked paths and observed before/after versions;
- parent Change IDs and observed commit IDs;
- validation evidence; and
- operation ID.

The model supplies semantic intent and description. Tool handlers inject opaque tracked source/workspace handles and active claims/leases; strong `JjOperations` capabilities supply known cwd, expected Change IDs, exact revsets, and mutation sequence. Model-visible mutation inputs never accept raw cwd, tracked Change IDs, filesets, revsets, or JJ argv. If path extraction is ambiguous, the operation stops before mutation and the task is rerouted to isolation.

## 6. Isolated JJ workspace model

### Creation

Creation records the repository, source workspace/path, source orchestration Change ID, diagnostic base Change ID, workspace name/path, isolated root Change ID, and initial workspace-head Change ID. The durable isolated identity is root plus the expected current workspace head; report freeze additionally derives the last nonempty content tip. Commit IDs are never tracking identity.

```text
base (recorded source @-)
├── source wip @
└── isolated root @
```

Creation must not checkpoint, rewrite, abandon, copy, or edit source `@`. A nonempty source working-copy change is valid.

### Work and planner history hygiene

All child file operations use the isolated path. Before reporting completed work, the child:

1. acknowledges all descendant reports;
2. runs slice validation;
3. calls `workspace_checkpoint` after each coherent writable unit, which records every expected workspace-head transition;
4. removes safe empty internal revisions while preserving the root anchor;
5. calls `prepare_workspace_report` to pause writes and capture current head plus last nonempty content tip;
6. inspects the inclusive `root::content-tip` range; and
7. reports exact Change-ID boundaries and validation.

The child does not claim that this history is accepted. It only declares it ready for review.

### Manual workspace rebase

After an explicitly requested local fetch/update, the thinker may call `rebase_workspace` to move an isolated workspace range onto a newer local base. Fetching is separate and never implicit. The rebase target is either the current source `@-` or one exact user-selected local Change ID; arbitrary revsets are not accepted.

The operation pauses the workspace writer, acquires the workspace-wide token and repository mutex, verifies that `root::workspace-head` has no foreign descendants, and rebases from the exact root so all owned descendants move together. It must preserve:

- root Change ID;
- content-tip Change ID;
- expected empty workspace-head Change ID;
- exact owned range membership and order; and
- semantic descriptions.

The root's immediate parent/base Change ID and every commit ID may change. The receipt records old/new base, unchanged range identities, normalized patch evidence, conflicts, and JJ operation ID. A clean range-equivalent result refreshes evidence. Changed normalized range evidence requires review again. A conflict is a known `conflict_resolution_required` state, not unknown partial mutation. No active child resumes writes until the receipt is persisted and it reacquires the workspace token.

### Thinker review

After acknowledging the report, the thinker refreshes from the task plan and obtains a deterministic read-only review bundle:

- recorded and actual source/workspace identities;
- root, recorded/current workspace head, content tip, and canonical inclusive `root::content-tip` range;
- diagnostic original/current bases without requiring stable commit IDs;
- per-change description, parents, emptiness, conflicts, normalized patches, and changed paths;
- bounded cumulative diff evidence with large artifacts kept out of parent context;
- workspace status and evidence of known or unknown post-report mutation;
- overlap with source changes since allocation; and
- planner validation evidence.

For every nonempty isolated range, a reviewer compares that exact range with the task-plan snapshot. The thinker evaluates the reviewer findings, history shape, tests, scope, and overlap. Outcomes are:

- request changes in the same preserved workspace;
- approve with an immutable review receipt;
- close with no changes after emptiness proof; or
- repair one goal-blocking/high finding and run one focused re-review;
- defer lesser findings to the user; or
- stop affected mutation when identity, ownership, or recovery is ambiguous.

### Changes requested

A correction is a new execution cycle against the same workspace custody record. The prior report and review remain immutable history. The thinker sends bounded review findings to a recreated or resumed child SDK context, and approval requires a new recorded head/content tip and review receipt. Automatic repair is limited to one implementation cycle plus one focused re-review.

### Integration

Integration is serialized with all source checkpoint mutations. It requires:

- a completed and acknowledged child;
- a frozen delegated workspace with no active writer;
- a reviewer receipt accepted by the thinker and matching current normalized patches or a patch-equivalent clean rebase;
- uniquely resolved source WIP, root, workspace-head, and content-tip Change IDs;
- a connected inclusive `root::content-tip` range with no foreign heads;
- no recovery history or divergent identity; and
- an acquired repository mutation lock.

Deterministic code then:

1. refreshes stale workspace metadata without accepting recovery history;
2. ignores commit-ID-only rewriting and rechecks Change IDs, connectivity, normalized patches, and conflicts under the lock;
3. preserves the approved inclusive Change-ID range and dependency order;
4. captures the complete recovery identity set before any destructive boundary;
5. forgets the delegated workspace only at the exact JJ mutation boundary where it is required;
6. handles only the exact approved empty-revision cleanup;
7. integrates retained changes before the source orchestration Change ID;
8. verifies ancestry, conflicts, descriptions, and source content preservation;
9. removes the delegated directory only after repository state no longer depends on it;
10. updates the main workspace from stale state at a safe point; and
11. returns an integration receipt that records every completed boundary.

A crash between known receipt boundaries is reconciled and may continue from the next proved idempotent phase. Owned, unambiguous JJ conflicts enter the bounded reviewer→worker→`squash_resolution`→focused-review flow. The thinker always reports the conflict and resolution path to the user, including affected files/Change IDs, worker and squash targets, validation, reviewer outcome, and deferred concerns. Unknown partial state, divergent identity, foreign work, or ambiguous squash targets stop affected JJ mutation; no guessed rollback follows.

### Verification and closure

Integration is not completion. The thinker runs acceptance checks in the integrated source state and compares the result with the approved review receipt.

- Success closes the workspace as `closed` and releases custody.
- An empty approved range closes as `closed_no_changes` without synthetic history.
- Verification failure preserves integrated history and records `attention_required` or a new explicit corrective task; it does not silently rewrite the reviewed changes.

## 7. Parent/child protocol

Children are private in-process Pi SDK contexts. Communication uses custom child/parent messages; it never impersonates the user and never imports a child transcript.

### Push and acknowledgement

A question or terminal report is pushed into the parent at Pi's safe steer boundary. If the parent is idle, the event triggers a turn. If it is active, the event joins the next model turn after current tool calls settle.

The parent calls `ack_child_event` after consuming the bounded report. Acknowledgement:

- advances terminal custody state;
- imports the usage receipt exactly once;
- proves the parent has not orphaned terminal work; and
- does not transfer child history.

A delegating child cannot terminally report while any direct child is unresolved or unacknowledged.

### Awaiting

`await_child_event` is wait-any but is no longer the delivery mechanism. It is a token-free suspension used only when the parent has no independent work. Any pushed question or terminal event wakes it. A user message cancels only the await.

### Questions and messages

Questions are correlated by ID. `message_child` sends a custom parent message with the response. The child resumes its saved work or descendant-await state. General steering uses the same message channel. If the child is suspended in a stale await, only that await is aborted before delivery; descendants continue.

### Status and context bounds

`child_status` reads coordinator metadata only. `request_child_status` sends a correlated request for a bounded semantic summary:

```text
request status
→ interrupt child await only if needed
→ child sends bounded status custom message
→ parent sees no transcript
→ child resumes saved activity
```

A status-only turn cannot trigger settlement. A timeout returns partial metadata and leaves the child running.

### Restart and `/continue`

On root resume, reload, or `/continue`, `reconcile_children` recursively recreates safe `running`, `starting`, or suspended child SDK contexts from durable journals. Terminal work is not relaunched; unanswered questions are re-presented. A crashed or stalled child gets a linked replacement execution cycle only after the old writer is proved quiescent.

### User interruption

When the root is specifically executing `await_child_event`, the input hook immediately resolves only that wait before Pi applies its normal user-message steer path. The user message therefore cannot sit behind a tool that is waiting on a child. Children continue. During every other root activity, Pi's default queue/steer behavior remains unchanged.

## 8. Completion definitions

| Actor/artifact | “Complete” means |
|---|---|
| Scout/researcher | Evidence report is terminal and acknowledged |
| Shared worker | Terminal report acknowledged, file set released, caller validated, checkpoint receipt accepted |
| Isolated worker | Report acknowledged, range reviewed, integrated, verified, and workspace closed |
| Planner | Its report is terminal only after descendants are acknowledged and history is curated/frozen; overall slice remains review-pending |
| Reviewer | Findings are reported with severity/relation and acknowledged; it never repairs directly |
| Thinker | Every owned child is terminal and acknowledged; every workspace is closed, `closed_no_changes`, explicitly preserved, repairable, or mutation-stopped; user acceptance criteria are verified |
| User request | Verified outcome or honest blocked/attention handoff, never merely a delegation announcement |
