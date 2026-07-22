# Workspace capabilities and subagent backend implementation plan

## Status

Proposed for review. This plan does not change the implemented JJ-only subagent behavior until each migration slice is accepted.

The latest subagent checkpoint establishes the invariant this plan preserves: a parent may create a delegated workspace only through `spawn_child`; the child exclusively owns that workspace, the parent pauses non-orchestration work, parent messages use the durable child RPC channel, and the child reports before terminating.

## Outcome

Pi-Tai will support two workspace backends and two distinct ownership models:

```text
Workspace backends
├── JJ workspace       preferred when cwd is a JJ repository and jj is available
└── Git worktree       fallback when cwd is a Git repository and JJ is unavailable

Ownership models
├── relocation         standalone agent moves to a forked successor session in the workspace
└── delegation         parent remains in place; separate child owns workspace and reports back
```

The implementation must never infer ownership from the filesystem path alone. Every allocation records its backend, purpose, source session, source cwd, target path, base identity, lifecycle state, and owning logical session/delegation.

## Fixed decisions

### Capability namespace

Terminal commands use the reserved lowercase capability namespace:

```text
/cap:list
/cap:jj-workspaces on|off|status
/cap:git-worktrees on|off|status
/cap:subagents on|off|status
```

Backend-specific create/enter subcommands may be added under their namespace. Prompt templates remain `/name`; skills remain `/skill:name`.

### Capability leases

Capability provisioning and model-tool exposure are separate:

```ts
interface CapabilityLease {
  owner: "user" | `feature:${string}`;
  exposure: "service-only" | "model-tools";
}
```

- Direct standalone enablement acquires a `model-tools` lease.
- `/cap:subagents on` acquires a `service-only` lease on the selected workspace backend.
- A service-only lease gives `SubagentPort` a backend but does not expose relocation tools to a parent.
- Releasing the subagent lease must not disable a backend the user enabled independently.
- Parent and child roles reject direct relocation commands and tools even if stale capability state is reconstructed.

### Backend selection

Subagents resolve their backend before mutation:

1. use JJ when `jj` is executable and cwd is in a JJ repository;
2. otherwise use Git when `git` is executable and cwd is in a Git repository;
3. otherwise activation is unavailable.

Do not fall back to Git after a JJ create/integrate operation has started or partially failed. Explicit backend override is deferred.

### Direct relocation

Direct create-and-enter is allowed only from `standalone` role while the agent is idle and the source workspace satisfies backend cleanliness requirements.

The operation:

1. allocates a workspace with purpose `relocation`;
2. creates a successor Pi session with `SessionManager.forkFrom(sourceSessionFile, targetCwd)`;
3. appends workspace-transition metadata to the successor session;
4. switches with `ExtensionCommandContext.switchSession()`;
5. reconstructs the new runtime at the target cwd;
6. remains `standalone` and continues normal work.

The old Pi session remains a resumable ancestor. The successor has no delegation record, parent callback, `report_to_parent`, or integration obligation.

Because model tools cannot switch sessions directly, model-initiated relocation is two-stage: a backend-specific tool queues its matching `/cap:` extension command as a follow-up after the tool turn settles. The extension command owns allocation, fork, and switch. User invocation may call the extension command directly.

Hosted relocation preserves the stable broker session ID while atomically updating its Pi session ID/file, cwd, projection revision, and workspace attachment. It is not a new child broker session.

### Delegated workspace ownership

`spawn_child` remains the sole workspace allocator visible in parent mode:

1. parent is already in `parent` role;
2. `SubagentPort` acquires its service-only backend lease;
3. `spawn_child` allocates a workspace with purpose `delegation`;
4. a distinct persistent child Pi session starts with the workspace as cwd;
5. parent non-orchestration work remains blocked while any child is active;
6. `message_child` sends steering/follow-up messages through the child control channel;
7. child calls `report_to_parent` and shuts down;
8. parent integrates or abandons using backend-specific behavior.

Hosted delegation creates a separately identified child broker/Pi session linked to its parent. It does not remap the parent's broker session.

### Paths

- JJ: `<repo>/.jj/workspaces/<workspace-name>`.
- Standalone Git default: `~/.pi/agent/pi-tai/workspaces/git/<repo-key>/<workspace-id>`.
- Hosted Git: platform Host application-data equivalent.

Every result and record contains the canonical absolute path. Git worktrees must not be placed as unignored nested directories inside the source checkout.

## Domain contracts

### Capability controller

Add a small first-party controller, not a second plugin framework:

```ts
interface SessionCapabilityController {
  snapshot(): CapabilitySnapshot;
  enable(id: CapabilityId, lease: CapabilityLease): Promise<CapabilitySnapshot>;
  disable(id: CapabilityId, owner: CapabilityLease["owner"]): Promise<CapabilitySnapshot>;
  isToolExposed(id: CapabilityId): boolean;
}
```

It owns persisted user intent, derived internal leases, deterministic active-tool composition, conditional prompt layers, availability, and cleanup. Tool activation is calculated as a union so one feature cannot remove tools still owned by another.

### Workspace port

```ts
type WorkspaceBackendKind = "jj" | "git";
type WorkspacePurpose = "relocation" | "delegation";

interface WorkspacePort {
  readonly kind: WorkspaceBackendKind;
  probe(cwd: string): Promise<WorkspaceAvailability>;
  create(request: WorkspaceCreateRequest): Promise<WorkspaceRecord>;
  status(record: WorkspaceRecord): Promise<WorkspaceStatus>;
  captureTip(record: WorkspaceRecord): Promise<WorkspaceTip>;
  integrate(record: WorkspaceRecord): Promise<WorkspaceIntegrationResult>;
  finalize(record: WorkspaceRecord): Promise<void>;
  abandon(record: WorkspaceRecord): Promise<WorkspaceAbandonResult>;
}
```

`SubagentOrchestrator` depends on `WorkspacePort`; it no longer imports `JjWorkspaceService` directly. Backend-specific identities remain tagged unions rather than nullable JJ and Git fields mixed in one object.

### Durable records

Use separate records:

- `WorkspaceTransitionRecord` for standalone relocation;
- `DelegationRecord` containing a tagged workspace attachment for child ownership.

Bump delegation record version and provide a bounded migration from the current JJ-only record. Existing JJ delegation IDs, root/tip change IDs, control paths, reports, and lifecycle states must survive migration unchanged.

## Backend semantics

### JJ relocation

- Require a clean source working copy using the existing JJ cleanliness proof.
- Create the successor workspace from source `@`, preserving the old working-copy change as ancestry.
- Record source workspace/change ID and successor root change ID.
- Do not rebase the successor back automatically: it is now the standalone agent's active line of work.
- If session fork/switch fails after allocation, retain a recoverable transition record and workspace rather than guessing that deletion is safe.

### JJ delegation

Preserve the implemented topology:

- create from parent `@-`;
- record `baseChangeId` and `childRootChangeId`;
- child owns the root and descendants;
- integrate with `jj rebase -s <childRootChangeId> -B <parentWorkspace>@`;
- finalize only after parent verification;
- never squash or abandon child changes automatically.

### Git relocation

- Require a Git repository, clean source checkout, and non-conflicting target path.
- Create a dedicated branch/ref and managed worktree from source `HEAD`.
- Record repository identity, base commit, branch/ref, path, and source checkout.
- Fork/switch the Pi session exactly as in JJ relocation.
- The successor works normally on the dedicated branch; there is no automatic merge-back requirement.

### Git delegation

The Git fallback proof must settle these semantics before enabling it by default:

- create a dedicated child branch and worktree from parent `HEAD`;
- require the child to report a clean worktree and capture its branch tip;
- preserve child commits without squashing;
- integrate through an explicit non-squash merge or reviewed rebase selected by the proof;
- surface conflicts without force-resetting either checkout;
- never delete a branch or dirty worktree during generic cleanup;
- if abandonment encounters uncommitted files, leave the worktree in place and report the recovery path.

The implementation must not imitate JJ change IDs with Git commit IDs or assume uncommitted Git work can be integrated.

## Implementation slices

### W0 — Freeze ownership contracts

#### Red

- Parent direct workspace tool and shell creation attempts are blocked.
- Parent work remains paused after `spawn_child`.
- Child RPC messaging and reporting remain durable.
- Standalone relocation and delegated ownership records cannot be confused.
- Capability command names cannot collide with prompts or skills.

#### Green

- Add domain fixtures for capability leases, workspace records, and both ownership models.
- Add the plan and repository contract assertions without changing runtime behavior.

#### Checkpoint

```text
test(workspaces): define relocation and delegation contracts
```

### W1 — Add the session capability controller

#### Red

- User and internal leases compose independently.
- Service-only leases never expose tools.
- Tool ownership uses a union and survives dynamic additions.
- New/forked sessions receive defaults; resume reconstructs persisted intent.
- Parent/child roles reject relocation exposure.

#### Green

- Add capability descriptors, registry/controller, persistence entries, prompt composition, and `/cap:list`.
- Move subagent activation to `/cap:subagents` while preserving current role and child behavior.
- Add backend capability shells with no create operations yet.

#### Checkpoint

```text
feat(capabilities): add session capability leases
```

### W2 — Extract the workspace backend boundary

#### Red

- Current JJ delegation fixtures pass through a fake `WorkspacePort`.
- Current version-1 delegation records migrate losslessly.
- Backend-specific identities reject fields from the other backend.

#### Green

- Extract `JjWorkspacePort` from `JjWorkspaceService`.
- Refactor `SubagentOrchestrator` to use the port without changing JJ behavior.
- Add versioned workspace/delegation stores and recovery diagnostics.

#### Checkpoint

```text
refactor(subagents): abstract workspace ownership
```

### W3 — Implement standalone JJ relocation

#### Red

- `/cap:jj-workspaces` is unavailable outside JJ repositories.
- Create-and-enter rejects non-standalone, streaming, unsaved-session, and dirty-workspace states.
- Success creates a workspace from source `@`, forks the full Pi session, switches cwd, and remains standalone.
- Work context, title, model/thinking state, and capability intent reconstruct.
- Old-context use after `switchSession` fails the test.
- Cancellation/failure leaves a recoverable workspace record.

#### Green

- Add direct JJ commands and the optional model-facing relocation request tool.
- Implement `SessionManager.forkFrom` plus `ctx.switchSession(..., { withSession })` flow.
- Add transition metadata and status/list operations.

#### Checkpoint

```text
feat(workspaces): relocate standalone sessions with JJ
```

### W4 — Implement Git worktree relocation

#### Red

- Git availability and target-path checks.
- Branch/ref and base-commit durability.
- Full-session fork/switch parity with JJ.
- Dirty worktrees are never force-removed.

#### Green

- Add `GitWorktreePort` create/status/finalize behavior for relocation.
- Add `/cap:git-worktrees` direct commands and tool exposure.
- Add managed-path collision and stale-record recovery.

#### Checkpoint

```text
feat(workspaces): relocate standalone sessions with Git worktrees
```

### W5 — Add Git fallback to subagents

#### Red

- `/cap:subagents on` selects JJ before Git.
- No fallback occurs after JJ mutation starts.
- Parent receives no direct backend tools from its internal lease.
- Git child cwd/session/control/report behavior matches JJ child behavior.
- Git integration preserves commits and reports conflicts.
- Dirty abandoned worktrees remain recoverable.

#### Green

- Generalize child records, generated facts, launcher inputs, integration, finalization, and abandonment by backend.
- Add Git-specific child completion requirements and parent result text.
- Keep current parent pause and `message_child` behavior unchanged.

#### Checkpoint

```text
feat(subagents): fall back to Git worktrees
```

### W6 — Add hosted ownership operations

This slice joins the Host roadmap rather than blocking terminal workspace support.

#### Red

- Direct relocation preserves broker session ID and advances revision while replacing Pi session mapping/cwd.
- Delegation creates a separate child broker/Pi session.
- Worker crash between allocation, session fork, and broker remap reconstructs an honest recoverable state.
- Old runtime/session events cannot mutate the successor projection.

#### Green

- Add Rust-owned runtime/Host DTOs for capability state, workspace allocation, relocation, and child linkage.
- Add Host transaction/reconciliation behavior and normalized workspace events.
- Map ACP/mobile operations only after the broker contract is durable.

#### Checkpoint

```text
feat(broker): add workspace relocation and delegation ownership
```

### W7 — Acceptance and migration

- Update README, product, Host, ACP, and subagent documentation.
- Remove the old unnamespaced `/sub-agents` command after migration acceptance rather than carrying two permanent command surfaces.
- Run isolated real-repository smoke tests in temporary JJ and Git repositories.
- Verify package contents and terminal Pi load.

Required checks:

```bash
npm run check
npm run smoke:isolated
npm run package:check
git diff --check
pi -ne -e . "<workspace capability regression prompt>"
```

Final checkpoint:

```text
feat(workspaces): add capability-gated session isolation
```

## Explicit non-goals for the first implementation

- Automatically moving a parent session into a child's workspace.
- Letting parent and child write the same workspace.
- Changing cwd with `process.chdir()` or a persistent shell `cd`.
- Silent fallback after backend mutation starts.
- Squashing JJ or Git child history automatically.
- Deleting dirty Git worktrees or child branches automatically.
- Making every standalone workspace remotely visible before Host ownership is durable.
