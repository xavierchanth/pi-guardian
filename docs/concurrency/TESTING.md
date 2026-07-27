# Concurrency and JJ testing

Correctness tests and model-behavior evaluations are separate. Live-model evals guide improvement but do not replace deterministic state and Real-JJ tests.

## Layers

| Layer | Model | JJ | Purpose |
|---|---:|---:|---|
| Domain/unit | no | no | State transitions, queues, receipts, bounds, severity policy |
| Service contract | no | scripted | Command construction, failure classification, idempotency |
| Real-JJ operation E2E | no | pinned real binary | Independent before/operation/after graph proof |
| SDK integration | fake/local | optional | Push, waits, cancellation, compaction, restart, usage |
| Policy eval | live optional | no | Role/tool/routing/report behavior |
| Real-JJ agent eval | live optional | real | Prompt→tools→independently verified repository state |

Repository-agent eval command:

```bash
pi -ne -e . "<prompt>"
```

## Real-JJ fixture

Each test uses a fresh temporary repository and isolated deterministic config.

1. Initialize repository/workspaces.
2. Seed semantic named changes/files.
3. Capture normalized before snapshot.
4. Call exactly one public semantic operation.
5. Capture normalized after snapshot.
6. Assert graph, Change IDs, descriptions, conflicts, workspaces, files, and receipt independently.
7. Retain fixture and `jj op log` only on failure.

Normalized equality excludes commit IDs unless rewrite itself is under test.

## Executor contracts

- Probe accepts one explicitly supported JJ version before managed mutation.
- Production inherits intended user/repository identity and policy but never edits config.
- Managed commands use built-in names and explicit long-form options.
- Missing binary, spawn failure, nonzero exit, cancellation, timeout, and output overflow are distinct.
- Model schemas omit cwd, tracked IDs, filesets, revsets, and argv.
- Read-only reviewer capabilities expose no mutation methods.

## Deterministic scenario groups

### Source working change and shared changes

- arbitrary nonempty, user-described source `@` remains unchanged;
- a merge source `@` blocks rather than selecting a parent;
- inserted target anchors on source `@-` and preserves source `@` bytes, identity, and description;
- checkpoint moves only claimed paths;
- unrelated working-change content remains untouched;
- two overlapping writers serialize edit→checkpoint;
- pre-lock changes refresh;
- in-lock changes breach;
- interrupted squash reconciles completed/safe/unknown states.

### Isolated workspace

- allocation from source `@-` preserves dirty source `@`;
- exact root/head/source identities captured;
- repeated checkpoints form named linear Change IDs plus one empty head;
- unexpected unreceipted head stops;
- manual rebase preserves root/content-tip/head and range order;
- changed patches stale review;
- owned conflict preserves custody;
- foreign descendant/divergent target stops safely.

### Freeze, review, and integration

- empty head derives last nonempty content tip;
- inclusive range contains both boundaries;
- all-empty work proves no-change;
- unnamed/empty normalization is exact;
- review receipt binds task plan and normalized patches;
- dirty source integration preserves working-change bytes, identity, and description;
- conflict resolution targets owning changes and re-reviews;
- crash after every persisted boundary resumes only next phase;
- cleanup failure yields cleanup-pending.

### Recovery

- explicit rebind requires user authorization and unique owned replacement;
- resume cannot repeat completed boundary;
- cleanup retry cannot mutate graph or discard changes;
- unknown partial state remains mutation-stopped.

## SDK lifecycle scenarios

- active-parent steer and idle-parent trigger;
- no user-role protocol messages;
- terminal acknowledgement exactly once;
- interactive input interrupts only await;
- root abort leaves children running;
- explicit cancellation isolates siblings and preserves custody;
- focused summary never exposes history;
- independent child compaction and journal reopen;
- post-order restart and unanswered-question restoration;
- no simultaneous old/replacement writer;
- locks reset and writers reacquire after restart;
- usage counted once by model/role/context/cycle;
- separate roots cannot observe one another.

## Policy eval cases

Score whether the model:

- selects inline/shared/isolated correctly;
- creates planner only through isolated workspace spawn;
- uses reviewer for every nonempty isolated range;
- requests bounded summary rather than history;
- waits only when no independent work remains;
- classifies blockers correctly;
- respects one automatic repair cycle;
- uses insert/checkpoint for shared source;
- uses workspace checkpoint for isolated work;
- avoids arbitrary mutating JJ shell;
- reports conflict resolution to the user.

Fixtures declare expected and forbidden tools, lifecycle assertions, report fields, and optional rubric checks.

## Real-JJ agent benchmark

Representative opt-in cases:

1. small shared change inserts a target after source `@-` and checkpoints one file without rewriting source `@`;
2. two shared workers serialize on one file;
3. planner creates several coherent checkpoints and expected empty head;
4. manual rebase onto newer local base preserves range identities;
5. normalization fixes unnamed/empty history before review;
6. owned conflict is repaired, squashed, reviewed, and reported;
7. foreign conflict stops and asks;
8. root restart resumes children with reacquired claims;
9. unexpected head stops until user-authorized rebind;
10. compacted child completes without leaking history.

The harness independently asserts final filesystem, graph, receipts, events, bounded messages, forbidden tools, and usage regression budgets.

## Gate policy

- Domain, scripted-executor, Real-JJ operation, SDK, persistence, type, package, and isolated-load tests gate correctness.
- Real-JJ operation tests are required in the primary supported environment.
- Live policy and Real-JJ agent evals are explicit, non-gating benchmarks.
- Failures retain normalized evidence and bounded event logs, never hidden reasoning.
