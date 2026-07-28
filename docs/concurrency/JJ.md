# JJ coordination

## Purpose

Pi-Tai uses JJ as the only managed workspace backend. JJ Change IDs provide durable semantic identity across normal rewriting; commit IDs are observational evidence only.

Models choose intent, scope, descriptions, and findings. Deterministic operations choose exact paths, revsets, command order, locks, receipts, and postcondition checks.

## Identity rules

- Every tracked Change ID resolves with `exactly(change_id(<id>), 1)`.
- Durable isolated identity includes root and expected workspace-head Change IDs.
- Report freeze adds the last nonempty content-tip Change ID.
- Review covers the inclusive exact `root::content-tip` range.
- Commit-ID changes alone never invalidate ownership or review.
- Source `@` and `@-` are operation-time revsets, never durable isolated-workspace identities.
- An unexplained tracked Change-ID change stops automatic mutation.
- Divergent IDs are never resolved by selecting an arbitrary side.

## Per-session orchestration change

Repository enrollment creates a managed workspace root and a private `pi_tai_private()` revset policy. Every Host session receives an independent workspace based on the invoking workspace's `@-`:

```text
invoking @- at allocation time
├── invoking user @
└── pi-tai: session <id>  ← managed session @
```

The managed session change receives integrated task work. Pi-Tai records its workspace name, path, and orchestration Change ID under Host custody; it does not persist the invoking source `@` or `@-`. Allocation and cleanup run under a repository mutation lease. Cleanup refuses to forget a session workspace while its orchestration change contains unresolved work.

## Task-plan artifact

For substantial work, the orchestrator maintains a durable state-owned task tree rendered into immutable content-addressed Markdown snapshots containing:

- objective and acceptance criteria;
- decisions and constraints;
- task slices and ownership;
- workspace root/head/content-tip Change IDs and the current operation-time source position;
- review/integration state;
- deferred findings.

The Orchestrator goal and sourced user directions are immutable. An Implementation Lead or Documenter assignment binds the current Orchestrator plan revision, digest, and user-direction count when its workspace is queued; no user approval is required. Implementation Lead and Worker projections omit superseded plan text. Reviewers receive an immutable full-history snapshot with current and superseded revisions clearly labeled. Child contexts execute bound task nodes without importing parent conversation history.

## Shared-source lane

### Shared target allocation

`insert_change` creates a named empty feature change as a child of source `@-`, immediately before the user's working change, and binds it to one owner. Source `@` is ordinary user working state. Its identity and sole parent are resolved when insertion executes; neither is persisted as source-wide ownership policy. Pi-Tai never describes it, and only path-scoped checkpoint or approved integration operations rewrite its graph while preserving unrelated content.

```text
source @- (recorded base)
└── feature target: feat(...)
    └── user @ (preserved)
```

### File-set claim

A shared writer requests its complete repository-relative semantic path set. Existing paths canonicalize directly; new paths canonicalize through their nearest existing ancestor. Choosing the paths is model intent, while repository identity and absolute cwd remain injected.

- equal and ancestor/descendant paths collide;
- a set grants only when it conflicts with neither an active claim nor an earlier overlapping waiter;
- disjoint sets may run concurrently;
- multi-file sets grant atomically in canonical order;
- pre-lock changes cause re-read;
- guarded writes refresh the claim's owned fingerprints;
- changes while held indicate an ownership breach;
- scope widening requires checkpoint/release then a new claim;
- no terminal result may release uncheckpointed owned changes;
- persisted queued, active, or checkpointing claims become interrupted after restart; live authority and queue position never restore.

Critical section:

```text
acquire complete set
→ re-read current content
→ edit
→ validate affected scope
→ checkpoint only owned paths into assigned Change ID
→ verify receipt
→ release complete set
```

`checkpoint_change` receives an injected claim containing cwd, paths, source base, source working change, and assigned target. None are copied from model input. It preserves unrelated working-change content, identity, and description.

## Isolated lane

### Workspace allocation

The Orchestrator resolves source `@-` when allocation executes and creates the isolated root there without changing source `@`:

```text
source @- at allocation time
├── source @
└── isolated root @
```

Source `@` and `@-` may move freely before later operations. Custody records the source workspace locator, managed name/path, and only the isolated root and expected head Change IDs. It does not persist a source base or source working-copy Change ID. No Git fallback or shared fallback occurs after allocation begins.

### Workspace file claims and checkpoint

Each isolated workspace owns an independent file-set coordinator. Multiple writable contexts may proceed concurrently when their complete canonical path sets are disjoint. Equal and ancestor/descendant paths conflict within one workspace; the same path in another workspace has independent ownership.

New workspaces use the shared-file checkpoint shape:

```text
assigned target A
└── assigned target B
    └── stable managed workspace head @
```

A writable task receives one assigned target Change ID. `acquire_workspace_file_set` grants its complete path set atomically. `checkpoint_workspace_file_set`:

1. validates the context, workspace, assigned target, active claim, and path fingerprints;
2. verifies current `@` is the stable managed workspace head;
3. moves only claimed paths from that head into the assigned target;
4. verifies unrelated working-head content and other targets are unchanged;
5. persists exact path, patch, target, working-head, and JJ operation evidence;
6. releases the claim only after the receipt is durable.

An isolated worker checkpoints through file claims and cannot mutate through arbitrary shell JJ commands.

### Freeze and normalization

Before reporting:

- all descendants are terminal and acknowledged;
- all coherent writes are checkpointed;
- safe empty interior changes are removed;
- every retained nonempty change is semantically named;
- expected empty working head remains tracked but excluded from review range;
- writes pause;
- root, workspace head, and last nonempty content tip are captured;
- range/conflict/foreign-head evidence is produced.

An entirely empty range closes as no-change without creating synthetic history.

## Manual workspace rebase

Fetching is separate. The orchestrator may explicitly rebase the verified root and all owned descendants onto source `@-` as resolved when the rebase command executes, or onto one explicit exact local Change ID.

The operation holds workspace token and repository mutex and preserves:

- root, content-tip, and workspace-head Change IDs;
- range membership and order;
- semantic descriptions.

The root parent/base and commit IDs may change.

Result:

- `range_equivalent`: normalized range unchanged; review evidence can refresh;
- `range_changed`: identity remains valid, patches changed; re-review;
- `conflicted`: preserve custody and enter owned conflict workflow.

Foreign descendants, active/unquiesced writers, divergent target, or unknown partial state stop the rebase.

## Independent review

Every nonempty isolated range receives a read-only reviewer. The reviewer gets:

- task-plan snapshot and acceptance criteria;
- root/content-tip boundaries and expected workspace head;
- deterministic range/conflict bundle;
- implementation-lead validation and changed-path summary.

Findings have relation (`introduced`, `in_scope_existing`, `out_of_scope_existing`) and canonical severity (`p0`, `p1`, `p2`, `p3`, `p4`). Every p0/p1 must be fixed and removed by focused re-review; p2 requires a orchestrator repair/defer disposition; p3 may defer and p4 records information. Automatic repair is limited to one implementation cycle and one focused re-review unless the user supplies new direction.

Review clearance is an immutable receipt binding the task snapshot, exact identities, ordered Change IDs, normalized patch hashes, conflicts, and findings. Commit-ID-only rewrite does not stale it; patch changes do.

## Integration

Integration requires terminal acknowledged child, frozen workspace, accepted matching review receipt, exact connected range, no foreign/recovery history, and repository mutex.

Deterministic integration:

1. refresh benign stale metadata;
2. revalidate identities, patches, conflicts, and range under lock;
3. capture recovery identities;
4. forget workspace only at the documented mutation boundary;
5. remove only reviewed empty changes/expected empty head;
6. insert the reviewed nonempty range immediately before source `@` as resolved when insertion executes;
7. preserve the then-current source working-copy content;
8. verify ancestry, order, names, conflicts, and patches;
9. remove managed directory only after graph independence;
10. persist every phase and final receipt.

Integration is not completion. Product acceptance tests run in source state before custody closes.

## Conflicts

Owned unique conflicts are repair states:

```text
inspect exact conflict and owning targets
→ reviewer explains spec impact
→ orchestrator assigns bounded worker
→ acquire conflict file set
→ resolve and validate
→ deterministically squash each resolution into owning change
→ verify conflict-free range
→ focused re-review
→ report outcome to user
```

Foreign work, ambiguous targets, divergent identity, or exhausted repair budget stops mutation.

## Operation boundary

```text
model tool handler
→ inject tracked source/workspace handle or lease
→ semantic JjOperations
→ repository executor with mutex/phases/receipts
→ bounded JjProcessExecutor
→ pinned supported JJ binary
```

One repository mutation kernel/mutex exists per process and is shared across root coordinators. Source handles, claims, attempts, and receipts remain attributable to their root/session. Versioned atomic shared-source state persists shared-lane target ownership, claim transitions, attempts, and completed receipts. Isolated custody persists only its owned range identities, never source `@` or `@-` Change IDs.

The process executor uses argv directly, bounded output, cancellation, timeout, inherited policy configuration, no config edits, built-in commands, and explicit long-form options. It distinguishes missing binary, spawn failure, exit failure, cancellation, timeout, and output overflow.

## Forbidden behavior

- arbitrary model-visible mutating JJ shell;
- model-authored cwd, fileset, revset, tracked IDs, or argv for mutation;
- Git fallback;
- automatic fetch/push/bookmark/config mutation;
- nested writable workspaces;
- integration without review;
- synthetic no-op commits;
- guessed rollback or identity replacement;
- disposing nonempty unintegrated work without explicit authority.
