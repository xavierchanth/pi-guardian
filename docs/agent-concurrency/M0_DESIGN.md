# M0 foundation design

Status: implemented and validated.

Implemented checkpoints:

- `swvmkrzptxzx` — semantic JJ operation and structured process-executor boundaries;
- `tvrqsvqpqvvl` — reusable Real-JJ fixture and independent workspace assertions;
- `qrslutvolxlp` — strict concurrency IDs, state unions, reducers, and migration quarantine;
- `nnnrqsoptvlu` — concurrent private in-process Pi SDK session proof;
- `npvnorvrvxtu` — opt-in concurrency benchmark runner.

The production runtime still uses the pre-M0 subprocess child implementation; M0 proves and supplies foundations for B0/C0 rather than performing that migration.

M0 should establish the boundaries that every later concurrency/JJ slice depends on without implementing the final tools prematurely. Its four DAG slices remain independently checkpointable:

- A0: strict domain vocabulary, semantic JJ capability contracts, and migrations;
- A1: JJ process executor and Real-JJ fixture;
- A2: in-process Pi SDK child feasibility spike;
- A3: eval fixture runner.

A0–A3 may proceed in parallel. C0 begins only after A0 and A1 pass.

## First boundary: executing JJ

The current boundary is:

```ts
type JjCommandRunner = (cwd: string, args: string[]) => Promise<string>;
```

It is useful for small fake-runner tests, but it loses stderr, exit status, cancellation, timeout, version, output limits, and failure kind. It also mixes process execution with semantic JJ operations inside `JjWorkspaceService`.

Use three levels rather than making one class own every concern:

```text
model tool handler
        ↓ injects tracked context/lease
JjOperations (strong semantic capabilities)
        ↓
C0 JjRepositoryExecutor (repository mutex, operation phases, receipts)
        ↓
M0 JjProcessExecutor (one safe `jj` process invocation)
        ↓
configured JJ 0.43.0 binary
```

The important public-internal boundary is `JjOperations`: it describes behavior Pi-Tai cares about, not commands. `JjProcessExecutor` remains the narrow replaceable process seam. C0 adds repository-wide mutation coordination between them.

## Semantic JJ capabilities

Tool handlers must not pass cwd, Change IDs, filesets, revsets, or argv supplied by the model. They obtain opaque handles from the current execution context and lock coordinator, then call a strong operation.

Representative aggregate interface:

```ts
interface JjOperations {
  inspectStatus(source: SourceWorkspaceHandle): Promise<JjStatus>;
  ensureWip(source: SourceWorkspaceHandle): Promise<EnsureWipResult>;
  insertChange(
    source: SourceWorkspaceHandle,
    input: Readonly<{ description: ChangeDescription; owner: ChildContextId }>,
  ): Promise<InsertChangeResult>;
  checkpointChange(claim: CheckpointableFileSetClaim): Promise<CheckpointChangeResult>;
  checkpointWorkspace(
    lease: IsolatedWorkspaceWriteLease,
    input: Readonly<{ description: ChangeDescription }>,
  ): Promise<WorkspaceCheckpointResult>;
  createWorkspace(
    source: SourceWorkspaceHandle,
    input: Readonly<{ name: WorkspaceName; purpose: WorkspacePurpose }>,
  ): Promise<CreateWorkspaceResult>;
  prepareWorkspaceReport(workspace: FrozenWorkspaceHandle): Promise<WorkspaceReportResult>;
  integrateWorkspace(approval: ApprovedWorkspaceIntegration): Promise<IntegrationResult>;
}
```

The aggregate documents the subsystem. Individual handlers depend only on the smallest interface they need, for example:

```ts
interface WorkspaceCheckpointer {
  checkpointWorkspace(
    lease: IsolatedWorkspaceWriteLease,
    input: Readonly<{ description: ChangeDescription }>,
  ): Promise<WorkspaceCheckpointResult>;
}
```

The model-facing `workspace_checkpoint` schema therefore contains only `description`. The handler injects the caller's existing workspace write lease. The expected current head is loaded from tracked workspace state and verified internally; it is not an input the model can mistype.

The same rule applies elsewhere:

- `checkpoint_change` receives the active claim, whose durable binding already contains source workspace, complete file set, owner, WIP, and inserted target;
- `insert_change` receives a tracked source handle plus semantic description/owner, not a target Change ID;
- workspace/report/integration operations receive tracked custody or approval handles, not paths or ranges;
- output receipts expose Change IDs for tracking and diagnostics, but later mutation consumes tracked handles rather than copying those IDs back from model text.

Opaque handles are minted only after exact validation. Their private records resolve to one of the small known working copies:

```ts
type ManagedWorkingCopy =
  | { kind: "source"; sourceId: SourceWorkspaceId; path: AbsolutePath; wipChangeId: ChangeId }
  | { kind: "isolated"; workspaceId: WorkspaceId; path: AbsolutePath; rootChangeId: ChangeId; headChangeId: ChangeId };
```

This record is not a permissive caller input. Paths and tracked Change IDs come from the custody registry. The operation verifies them again at mutation time.

### Semantic capability invariants

- Tool authority and active leases are checked before JJ starts.
- One function represents one behaviorally meaningful JJ step and returns one strict result/receipt union.
- Callers do not assemble partial command sequences.
- Expected IDs are internal preconditions; newly observed IDs are outputs persisted before lease release.
- Every tracked ID resolves through `exactly(change_id(<id>), 1)`.
- No semantic mutation accepts an unrestricted revset, fileset, cwd, or arbitrary JJ arguments.
- Read-only interfaces are separated from mutation interfaces so reviewers cannot receive mutation capability accidentally.

M0 defines these contracts and introduces the executor seam. Implementations are added by C0/C2/C3/D0/D1/E3 as their behavior becomes available.

## Process executor

Use `JjProcessExecutor` for the production boundary and `ScriptedJjExecutor` for model-free contract tests. Retire `JjCommandRunner` after `JjWorkspaceService` migrates.

“Executor” is preferable here because the result includes process outcome, diagnostics, and cancellation rather than only stdout. It is never exposed as a model tool; only trusted `JjOperations` implementations construct JJ arguments and revsets.

### Request and result

```ts
type JjAccess = "read" | "write";

type JjExecutionRequest = Readonly<{
  cwd: AbsolutePath;
  args: readonly string[];
  access: JjAccess;
  timeoutMs: number;
  outputLimitBytes: number;
  signal?: AbortSignal;
}>;

type JjExecutionResult =
  | {
      kind: "success";
      stdout: string;
      stderr: string;
      exitCode: 0;
      durationMs: number;
    }
  | {
      kind: "failure";
      failure: JjExecutionFailure;
      stdout: string;
      stderr: string;
      durationMs: number;
    };

type JjExecutionFailure =
  | { kind: "not_found"; binary: string }
  | { kind: "spawn_failed"; reason: string }
  | { kind: "exited"; exitCode: number; signal?: string }
  | { kind: "cancelled" }
  | { kind: "timed_out"; timeoutMs: number }
  | { kind: "output_limit_exceeded"; limitBytes: number };

interface JjExecutor {
  execute(request: JjExecutionRequest): Promise<JjExecutionResult>;
  probe(signal?: AbortSignal): Promise<JjProbeResult>;
}
```

`JjProbeResult` records the selected binary and requires exact supported version `0.43.0`. A missing/unsupported binary is data, not an unclassified thrown exception.

`access` is an assertion used for diagnostics and tests in M0. It does not grant authority and does not yet provide locking. C0 wraps complete multi-command write operations in a repository-scoped mutex; locking each subprocess separately would allow unsafe interleaving.

### Process invariants

The production executor:

- invokes an argument vector directly, never a shell;
- uses only command names and long-form options such as `--revision`, `--template`, `--message`, `--repository`, and `--insert-before`;
- inherits user/repository JJ configuration, including identity, signing, and immutability policy;
- explicitly forces `--no-pager` and `--color=never`;
- bounds stdout and stderr separately;
- supports `AbortSignal` and a finite timeout;
- distinguishes cancellation, timeout, nonzero exit, spawn failure, missing binary, and unsupported version;
- never edits user, repository, or workspace configuration;
- records argv for diagnostics without constructing a shell command string;
- does not parse Change IDs, revsets, graph rows, or operation receipts.

User-defined aliases cannot replace the built-in command names Pi-Tai invokes. Explicit long-form options/templates avoid dependence on configured defaults where JJ exposes an override. Policy-bearing configuration such as signing and immutable heads remains active.

Semantic operations own command construction and parsing. Change-ID constructors accept only validated `ChangeId` values and always produce:

```text
exactly(change_id(<id>), 1)
```

### Configuration boundary

The executor receives immutable startup options rather than process-wide mutable settings:

```ts
interface JjExecutorOptions {
  binary: string;
  requiredVersion: "0.43.0";
  defaultTimeoutMs: number;
  defaultOutputLimitBytes: number;
}
```

Production inherits the invoking process's JJ configuration and identity. Real-JJ fixtures disable external configuration and provide deterministic identity command-locally. Neither path runs `jj config set`.

## Migration without a big bang

1. Add semantic operation contracts and opaque tracked handles without changing behavior.
2. Add `JjExecutor` and production/scripted implementations.
3. Adapt `JjWorkspaceService` from the function runner to `JjExecutor` while preserving its current `WorkspacePort` facade.
4. Preserve command-construction tests against `ScriptedJjExecutor`, now requiring long-form options.
5. Move direct `execFile("jj", ...)` test setup and assertions behind the Real-JJ fixture.
6. In C0, add `JjRepositoryExecutor`, then implement/migrate one strong `JjOperations` capability at a time.
7. Delete the old permissive service methods only after all callers use the semantic capabilities.

The temporary adapter may convert a failed execution result into the current service error shape. New semantic operations must classify failures explicitly.

## A0 — strict domain vocabulary

A0 should begin with opaque validated IDs and strict transition reducers, not persistence-shaped optional fields.

Initial semantic IDs:

- `RootSessionId`;
- `ChildContextId`;
- `ExecutionCycleId`;
- `ChildEventId`;
- `FileSetClaimId`;
- `WorkspaceId`;
- `ChangeId`;
- `JjOperationId`;
- `ReviewId`;
- `IntegrationId`;
- `RecoveryAuthorizationId`.

Initial strict unions:

- child execution lifecycle;
- child event acknowledgement;
- file-set claim lifecycle including `interrupted`;
- isolated workspace writer token;
- workspace custody;
- review and integration receipt disposition.

Persistence DTOs remain versioned and permissive enough to read legacy records. Conversion either returns a valid domain object or an explicit quarantine reason. It never fills required facts with guessed defaults.

A0 does not rewrite all existing delegation persistence immediately. Its first proof should convert one representative legacy/current fixture into the new internal type and quarantine one ambiguous fixture.

## A1 — Real-JJ fixture

A1 consumes `JjExecutor` and provides test-only helpers under a dedicated test-support module.

### Fixture API

```ts
interface RealJjFixture {
  readonly root: AbsolutePath;
  readonly repoPath: AbsolutePath;
  readonly executor: JjExecutor;

  seed(plan: JjSeedPlan): Promise<JjSeedReceipt>;
  snapshot(): Promise<JjFixtureSnapshot>;
  retainOnFailure(testName: string): Promise<RetainedFixture>;
  dispose(): Promise<void>;
}
```

The seed plan is semantic and bounded: create repository, files, named changes, and workspaces. It is not an arbitrary shell script.

The snapshot oracle independently queries:

- operation ID;
- workspace names, paths, and exact target Change IDs;
- Change IDs, exact parents, descriptions, empty/conflicted state, and changed paths;
- working-copy content hashes.

Commit IDs may be retained for diagnostics but are excluded from normal equality.

### First executable proof

The first A1 E2E test should migrate the existing “workspace relocation creates a successor above source `@-`” behavior to the fixture and independently assert:

- source `@` Change ID and bytes are unchanged;
- allocated root is a child of exact source `@-`;
- workspace target equals recorded root;
- no user/global config was changed;
- operation log advanced only by expected operations.

This proves the boundary before implementing new checkpoint commands.

## A2 — in-process SDK spike

A2 is deliberately throwaway-compatible: prove SDK behavior behind a narrow coordinator test seam before replacing subprocess records.

Required proof:

- two private `AgentSession` children run concurrently;
- each has exact model/tools/cwd and its own resource loader/session manager;
- root↔child custom messages do not use user-role messages;
- active-root steer and idle-root trigger both work;
- one child can cancel/dispose without affecting the other;
- private child journals can reopen but are absent from normal root session discovery;
- child compaction can use Pi-Tai's configured 90% policy independently.

No production child lifecycle migration belongs in A2.

## A3 — eval fixture runner

A3 establishes one report format for model-free policy fixtures and opt-in live-model cases.

The PR/default test lane remains deterministic and model-free. Live-model policy and Real-JJ agent evals are opt-in improvement instruments, not correctness tests or merge gates. Their reports track prompt/tool behavior, cost, and regressions over time.

The first two cases are:

1. synthetic shared-source task selects `insert_change` then `checkpoint_change`, never arbitrary mutating JJ shell;
2. empty Real-JJ repository agent case starts through `pi -ne -e .` and produces a separately verifiable final snapshot.

## M0 checkpoint sequence

Each item is a separate reviewable JJ checkpoint:

1. `refactor(jj): define semantic operation boundary`
2. `refactor(jj): add structured process executor`
3. `test(jj): add real repository fixture`
4. `refactor(concurrency): add strict foundation types`
5. `test(subagents): prove concurrent in-process sessions`
6. `feat(evals): add opt-in concurrency benchmark runner`

A0–A3 dependency order does not require this exact development order. The sequence minimizes migration risk by establishing the JJ boundary and fixture before new mutations.

## Recorded decisions

1. Production inherits user/repository JJ configuration so identity, signing, immutable-head policy, and other intended behavior remain active.
2. Pi-Tai never mutates JJ configuration and invokes built-in commands with explicit long-form options.
3. Managed production changes retain the user's configured JJ identity; fixtures use a fixed synthetic command-local identity.
4. JJ `0.43.0` is the exact initial runtime and CI contract.
5. Live-model evals are opt-in benchmarks for improving the harness, not required test gates.
6. Model-free domain/fake-executor tests, Real-JJ operation tests, and fake-model SDK tests remain normal correctness gates.
7. The `/continue` prompt-template decision does not block M0 and remains unchanged.
