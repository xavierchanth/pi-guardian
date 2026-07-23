# Agent concurrency testing and eval strategy

The concurrency/JJ subsystem needs deterministic correctness tests and separate model-behavior evals. Prompt evals are optional improvement instruments, not tests or merge gates. They cannot replace Real-JJ postcondition tests, and mocked JJ tests cannot prove command sequences work against JJ's actual operation model.

## Test layers

| Layer | Model | JJ | Purpose |
|---|---:|---:|---|
| Domain/unit | No | No | State transitions, exact-one resolution, lock queues, receipts, message bounds, severity policy |
| Service contract | No | Fake runner | Command construction, failure classification, idempotency decisions |
| Real-JJ tool E2E | No | Real pinned binary | Before/tool-call/after graph and workspace behavior |
| In-process SDK integration | Fake/local model | Optional real JJ | Parent/child push messages, wait interruption, compaction, crash/restart, usage |
| Policy eval | Live model | No | Role/tool choice, bounded reports, blocker disposition, no history access |
| Real-JJ agent eval | Live model | Real pinned binary | Prompt→tool calls→final JJ/filesystem postconditions |

All repository-agent evals run with only this distribution loaded:

```bash
pi -ne -e . "<prompt>"
```

## Real-JJ harness

Each test creates a fresh temporary repository and invokes the actual installed/pinned `jj` executable. Tests never use the developer's repository or global user configuration.

### Fixture lifecycle

1. Create a unique temporary directory.
2. Initialize a JJ repository, colocated only for scenarios that explicitly need Git interop.
3. Apply deterministic test-only user/config values through command-local configuration.
4. Seed named changes/files/workspaces through harness helpers.
5. Capture a normalized before snapshot.
6. Call exactly one public deterministic tool/service operation.
7. Capture a normalized after snapshot.
8. Assert graph, Change IDs, descriptions, conflicts, workspace targets, files, and receipts.
9. Preserve the fixture path and `jj op log` only on failure.

### Normalized snapshot

```ts
interface JjFixtureSnapshot {
  operationId: string;
  workspaces: Array<{ name: string; targetChangeId: string; path: string }>;
  changes: Array<{
    changeId: string;
    parentChangeIds: string[];
    description: string;
    empty: boolean;
    conflicted: boolean;
    changedPaths: string[];
  }>;
  workingCopies: Array<{
    workspace: string;
    changeId: string;
    contentHash: string;
  }>;
}
```

Commit IDs may be recorded for diagnostics but are excluded from equality assertions unless a test specifically proves that a rewrite occurred. Every tracked Change ID lookup uses `exactly(change_id(<id>), 1)`.

### Semantic-operation harness

The same strong JJ operation used by the public tool handler is callable without a model. The test fixture supplies the tracked handle/lease that the harness would normally inject:

```ts
const before = await fixture.snapshot();
const lease = await fixture.acquireWorkspaceWriteLease();
const result = await operations.checkpointWorkspace(lease, {
  description: "feat(runtime): add restart reconciliation",
});
const after = await fixture.snapshot();
expectWorkspaceCheckpoint({ before, result, after });
```

A separate handler contract test proves that the model-visible schema contains only `description` and injects the current lease. Tests assert both the operation receipt and independent JJ state; they do not trust operation output as proof of its own correctness.

### Executor and capability contracts

- Probe accepts exact JJ `0.43.0` and classifies every other version as unsupported before managed mutation.
- Production execution inherits a temporary test JJ configuration and never invokes `config set`/`config edit`.
- Every constructed command uses a built-in command name and long-form options; contract fixtures reject short options such as `-r`, `-T`, `-m`, or `-B`.
- `JjProcessExecutor` classifies timeout, cancellation, output limit, missing binary, spawn failure, and nonzero exit.
- Model-facing mutation schemas omit cwd, tracked Change IDs, filesets, revsets, and argv.
- Semantic operations receive only opaque tracked handles/claims/leases plus bounded semantic input.
- Reviewer dependencies expose read-only JJ capability interfaces with no mutation methods.

## Deterministic tool scenario matrix

### `ensure_wip_change`

- Empty unnamed `@` becomes canonical `wip: thinker workspace` with same Change ID.
- Existing recorded WIP is returned unchanged.
- Empty non-WIP topology requiring a fresh WIP records the expected transition.
- Nonempty unknown `@` returns a decision requirement without mutation.
- Missing private selector warns without editing config.
- Every lookup resolves exactly one Change ID.

### `insert_change`

- Inserts a named empty change before WIP.
- Preserves WIP Change ID and complete WIP file content.
- Returns the inserted Change ID and owner binding.
- Multiple inserted changes preserve deterministic order.
- Unknown/divergent WIP stops before mutation.
- Crash after each phase reconciles from operation/receipt evidence.

### `checkpoint_change`

- Moves only the locked files from WIP into assigned inserted Change ID.
- Preserves unrelated WIP files and WIP Change ID.
- Rejects an unlocked path or unassigned target.
- Holds the file set through squash and receipt verification.
- Two workers on one file produce `edit→checkpoint→edit→checkpoint`.
- Pre-lock content changes cause re-read, not failure.
- In-lock external mutation is detected as an ownership breach.
- Interrupted squash is classified as completed, safe-to-reissue, or unknown.

### `workspace_checkpoint`

- Starts with recorded `workspaceHeadChangeId === rootChangeId`.
- Describes current head without changing its Change ID.
- Creates one fresh empty child and records its Change ID as new workspace head.
- Verifies old head is exactly the new head's parent.
- Repeated checkpoints produce a named linear Change-ID sequence plus one empty head.
- Refuses when actual `@` differs from recorded head without a managed receipt.
- Clean base rebase changes commit IDs but not tracked Change IDs and does not fail.
- Conflict state is reported without losing the head transition.
- Interruption at describe/new/persist boundaries reconciles deterministically.

### `spawn_workspace_child`

- Dirty source WIP remains byte-for-byte and Change-ID identical.
- Workspace root is created from recorded source `@-`.
- Workspace name/path/root/head/source WIP are captured.
- Source/base clean rebase preserves valid tracking.
- Existing unknown path is never removed.
- Child-start failure leaves explicit recoverable custody.

### `prepare_workspace_report` / range inspection

- Expected empty current head derives last nonempty content tip.
- Inclusive exact `root::content-tip` includes both ends.
- Entirely empty workspace produces an empty-range proof.
- Every nonempty change is named before approval.
- Foreign descendant, divergent boundary, and unknown head transition are distinguished.
- Commit-ID-only rewrites refresh evidence.
- Patch changes force re-review.

### `normalize_change_range`

- Removes only approved safe empty interior changes.
- Preserves root anchor and the active expected empty workspace head until the recorded forget boundary.
- Applies supplied descriptions to exact Change IDs.
- Never invents a missing description.
- Returns old/new head and content-tip receipts.

### `integrate_workspace`

- Integrates into dirty source WIP while preserving WIP Change ID/content.
- Handles source/base clean rebases.
- Uses approved inclusive range only.
- Produces expected names/order and no extra changes.
- Owned conflict returns `conflict_resolution_required` with exact files/targets.
- Foreign conflict, divergent ID, recovery change, and unknown partial phase stop mutation.
- Crash after every persisted boundary resumes only the next idempotent phase.
- Directory cleanup failure becomes `cleanup_pending`, not semantic failure.

### `squash_resolution`

- Requires exact conflict target and locked paths.
- Squashes only resolution files into the selected Change ID.
- Leaves no conflict and preserves range connectivity.
- Multiple target changes require separate receipts.
- Ambiguous/foreign target is rejected before mutation.

### Recovery tools

- `rebind_tracked_change` requires an explicit user authorization event and exact unique replacement.
- Rebind refuses divergent, disconnected, or foreign replacements.
- `resume_workspace_operation` cannot repeat a completed boundary.
- `retry_workspace_cleanup` cannot mutate graph history or discard nonempty work.

## In-process SDK lifecycle scenarios

- Child completion while root streams is injected as a custom child message at the safe steer boundary.
- Child completion while root is idle triggers a root turn.
- Interactive user input during `await_child_event` cancels only the wait immediately; it is not trapped behind the wait.
- Interactive user input during normal root work preserves Pi's default steer/follow-up behavior.
- Specific child-summary requests return bounded answers without history access.
- Child auto-compaction at configured threshold persists and resumes.
- Root restart clears lock ownership, marks prior claims interrupted, and requires reacquisition.
- Read-only interrupted tools may reissue; mutating tools reconcile receipts first.
- `/continue` recursively recreates resumable descendants but not terminal/incident states.
- Old and replacement writers are never simultaneously active.
- Usage is counted exactly once and broken down by model, role, context, and execution cycle.

## Policy eval benchmark without JJ

This benchmark supplies synthetic task/lifecycle/tool results. It scores whether the model:

- chooses inline/shared/isolated routing correctly;
- uses planner only through workspace spawn;
- uses reviewer for every nonempty isolated range;
- requests bounded child details rather than history;
- waits only when it has no independent work;
- classifies blockers as wait/refresh/reroute/repair/warn/ask/stop correctly;
- respects one automatic reviewer repair cycle;
- selects `insert_change`+`checkpoint_change` for shared source work;
- selects `workspace_checkpoint` for isolated work;
- never requests arbitrary mutating JJ shell access; and
- reports conflict resolution to the user.

Cases should be stable YAML/JSON fixtures with expected tool names, forbidden tool names, required report fields, and optional natural-language rubric checks.

## Real-JJ agent eval benchmark

This layer gives the actual thinker/child prompts a seeded temporary JJ repository. The model performs real tool calls; the harness independently checks final state.

Example cases:

1. Small shared change creates WIP, inserts a target, edits one file, checkpoints, and leaves WIP clean for that file.
2. Two shared workers contend for one file and serialize checkpoints.
3. Planner makes three coherent workspace checkpoints and leaves the expected empty head.
4. Development base is rebased while planner works; integration continues by Change IDs.
5. Workspace report contains unnamed/empty changes; normalization occurs before reviewer approval.
6. Integration creates a trivial owned conflict; worker resolves, deterministic squash targets the correct Change ID, reviewer passes, user receives report.
7. Complex/foreign conflict stops mutation and asks the user.
8. Root restarts during child work; `/continue` recreates contexts and locks are reacquired.
9. Tracked workspace head changes unexpectedly; automatic work stops, then an explicit user prompt authorizes rebind and continuation.
10. Child context exceeds compaction threshold and completes without leaking history into root context.

### Eval assertions

- exact tool sequence constraints;
- no forbidden shell/JJ mutation;
- bounded parent context messages;
- expected child/reviewer lifecycle;
- expected root/head/tip Change IDs;
- expected descriptions and files;
- no unresolved conflicts unless case requires stop;
- source WIP identity/content preservation;
- receipt/event completeness; and
- token/cost regression budget by role/model.

## Correctness and eval policy

- Pin exact JJ `0.43.0` for the initial runtime and deterministic CI contract; add compatibility lanes only through an explicit later decision.
- Real-JJ tool E2E tests are required, not optional skips, in the primary CI environment.
- Domain, fake-executor, Real-JJ operation, and fake-model SDK tests are normal correctness gates.
- Live-model policy and Real-JJ agent evals run only when explicitly requested. Their outcomes guide harness/prompt improvement and do not gate merges.
- Eval repository postconditions reuse the deterministic assertion library so benchmark reports remain independently grounded.
- Failed test/eval fixtures retain normalized snapshots, tool receipts, bounded agent event logs, and `jj op log`; they never expose hidden reasoning.
