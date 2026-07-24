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
- The original base is diagnostic; an explicit clean rebase may change it.
- An unexplained tracked Change-ID change stops automatic mutation.
- Divergent IDs are never resolved by selecting an arbitrary side.

## Main orchestration change

The source workspace keeps one mutable private working change:

```text
named feature changes
└── wip: thinker workspace  ← source @
```

It holds active thinker work, shared-lane edits before checkpoint, and repository task plans. Pi-Tai records its Change ID separately from its description.

If no WIP exists and `@` is empty, deterministic code may describe/create it. Unknown nonempty user work is never silently relabeled. Pi-Tai recommends private-commit configuration but never edits user JJ configuration or bypasses immutability automatically.

## Task-plan artifact

For substantial work, the thinker maintains concise repository-visible Markdown containing:

- objective and acceptance criteria;
- decisions and constraints;
- task slices and ownership;
- source WIP, workspace root/head/content-tip Change IDs;
- review/integration state;
- deferred findings.

Children and reviewers receive bounded snapshots because isolated workspaces branch from source `@-` and do not inherit files present only in source `@`.

## Shared-source lane

### Shared target allocation

`insert_change` creates a named empty feature change immediately before the same source WIP and binds it to one owner.

```text
base
└── feature target: feat(...)
    └── source wip @
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

`checkpoint_change` receives an injected claim containing cwd, paths, source WIP, and assigned target. None are copied from model input. It preserves unrelated WIP content and identity.

## Isolated lane

### Workspace allocation

The thinker allocates from source `@-`, preserving source `@` bytes and Change ID:

```text
recorded source @-
├── source wip @
└── isolated root @
```

Custody records source workspace/WIP, diagnostic base, managed name/path, root, and expected head. No Git fallback or shared fallback occurs after allocation begins.

### Writer token and checkpoint

One writable context holds the workspace-wide writer token. Read-only children may run concurrently.

`workspace_checkpoint({ description })`:

1. verifies current `@` equals expected head exactly;
2. requires a semantic description;
3. describes current change without changing its Change ID;
4. creates one fresh empty working-copy child;
5. verifies exact parent relation and no divergence;
6. persists previous/checkpointed/new head IDs and operation receipt;
7. releases the token.

An isolated worker cannot mutate through arbitrary shell JJ commands.

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

Fetching is separate. The thinker may explicitly rebase the verified root and all owned descendants onto source `@-` or one exact local Change ID.

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
- planner validation and changed-path summary.

Findings have relation (`introduced`, `in_scope_existing`, `out_of_scope_existing`) and severity (`goal_blocking`, `high`, `medium`, `low`, `note`). The thinker decides repair. Automatic repair is limited to one implementation cycle and one focused re-review unless the user authorizes more.

Approval is an immutable receipt binding plan hash, exact identities, ordered Change IDs, normalized patch hashes, conflicts, and findings. Commit-ID-only rewrite does not stale it; patch changes do.

## Integration

Integration requires terminal acknowledged child, frozen workspace, accepted matching review receipt, exact connected range, no foreign/recovery history, and repository mutex.

Deterministic integration:

1. refresh benign stale metadata;
2. revalidate identities, patches, conflicts, and range under lock;
3. capture recovery identities;
4. forget workspace only at the documented mutation boundary;
5. remove only approved empty changes/expected empty head;
6. insert approved nonempty range before the same source WIP;
7. preserve source WIP ID and content;
8. verify ancestry, order, names, conflicts, and patches;
9. remove managed directory only after graph independence;
10. persist every phase and final receipt.

Integration is not completion. Product acceptance tests run in source state before custody closes.

## Conflicts

Owned unique conflicts are repair states:

```text
inspect exact conflict and owning targets
→ reviewer explains spec impact
→ thinker assigns bounded worker
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

One repository mutation kernel/mutex exists per process and is shared across root coordinators. Source handles, claims, attempts, and receipts remain attributable to their root/session. Versioned atomic shared-source state persists WIP identity, target ownership, claim transitions, attempts, and completed receipts.

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
