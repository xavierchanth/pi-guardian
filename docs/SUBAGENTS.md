# Pi-Tai subagents

Pi-Tai provides opt-in, two-tier delegation backed by persistent Pi sessions and isolated workspaces. JJ is preferred; Git worktrees are selected before creation when JJ is unavailable. Delegation is disabled by default.

## Roles and instructions

Each session has one durable role:

- `standalone`: no orchestration tools;
- `parent`: direct-child orchestration tools;
- `child`: only `report_to_parent`.

Children cannot delegate. New and forked sessions start standalone; resumed sessions reconstruct their role from session entries. A launched child also receives its delegation identity through the process environment and persists that identity in its session.

Pi-Tai composes the normal Pi system prompt with non-empty authored files in this order:

1. `packages/pi-tai/instructions/system.md`;
2. `packages/pi-tai/instructions/parent.md` or `child.md` when applicable;
3. generated factual runtime metadata.

All three Markdown files are intentionally empty and remain user-authored. Generated metadata includes the role and, for children, delegation/workspace/change IDs. Parent metadata lists the semantic model preferences.

## Activation and tools

Commands:

- `/cap:subagents on`: enable the parent role for this session;
- `/cap:subagents status`: show role and child counts;
- `/cap:subagents off`: return to standalone after every child is resolved.
- `/cap:jj-workspaces ...` and `/cap:git-worktrees ...`: manage direct standalone workspace transitions without entering parent mode.

Parent tools:

- `spawn_child`: create a JJ workspace, or a Git worktree fallback, and launch one bounded child that exclusively owns the work in it;
- `message_child`: steer a running child or queue a follow-up instruction through its persistent control channel;
- `wait_for_children`: block without parent LLM calls until the uncollected child snapshot resolves;
- `child_status`: inspect one or all direct children;
- `integrate_child`: rebase a completed child subtree, then separately finalize after verification;
- `abandon_child`: stop the child and remove its workspace without abandoning JJ changes.

Child tool:

- `report_to_parent`: persist `completed`, `blocked`, `failed`, or `cancelled`, capture the child tip change ID, wake parent waiting, and terminate the child run.

## Model profiles

The semantic model definitions are always-available Pi-Tai profiles, independent of whether subagents are enabled. Each profile registers an exact slash command that switches the current session's model and thinking effort:

- `/model:designer`
- `/model:thinker`
- `/model:worker`
- `/model:mechanical`

`spawn_child` reuses the same profile objects and selects intent rather than maintaining a separate provider/model configuration:

| ID | Intended work | Provider/model | Effort |
| --- | --- | --- | --- |
| `designer` | Open-ended product, system, and architecture design | `opencode-go/kimi-k3` | max |
| `thinker` | Investigation, planning, architecture, substantial judgment | `openai-codex/gpt-5.6-sol` | high |
| `worker` | Planned work requiring trusted engineering judgment | `openai-codex/gpt-5.6-sol` | low |
| `mechanical` | Explicit repetitive transformations | `openai-codex/gpt-5.6-luna` | high |

A profile switch fails without changing thinking effort when its model is not registered or lacks credentials. If a model clamps the requested effort, Pi-Tai reports both requested and applied levels. As with all extension commands, another extension registering the same command name causes Pi to assign numeric conflict suffixes; this distribution registers each unsuffixed profile command exactly once.

The launcher starts a persistent `pi --mode rpc` child with only the Pi-Tai extension, a persistent session, the selected profile's model and effort, and the child workspace as its working directory. A mode-`0600` FIFO carries the initial prompt and later `message_child` steering/follow-up commands, so messaging continues to work after a parent process restart. RPC output is retained beside the delegation records. After `report_to_parent`, the child requests graceful shutdown and removes its control FIFO.

## Backend topology

In parent mode, `spawn_child` is the only supported way to create a workspace for delegated work. Direct parent `jj workspace add`, `git worktree add`, and standalone relocation tools are blocked. The child exclusively owns the delegated workspace: all repository inspection, editing, testing, and VCS work for the task happens there. Once a child is active, non-orchestration parent tool calls are blocked until the child resolves; the parent must use child controls rather than inspect, modify, test, or duplicate the child's work.

For JJ delegation, `spawn_child` always branches from parent `@-`, whether parent `@` is empty or modified. It never checkpoints, moves, rewrites, or cleans parent `@`. Pi-Tai captures:

- the current parent workspace name;
- parent `@-` as `baseChangeId`;
- the new child workspace `@` as `childRootChangeId`.

It creates the workspace with:

```sh
jj workspace add <path> --name <name> -r <baseChangeId>
```

This creates the child's initial working-copy change above the stable base. Independently spawned children therefore begin as sibling changes instead of stacking on parent work or one another. Durable linkage uses change IDs, never commit IDs.

Before integration, Pi-Tai updates a stale child workspace and verifies that child `@` still descends from the recorded root. It then runs from the parent workspace:

```sh
jj rebase -s <childRootChangeId> -B <parentWorkspace>@
```

`-s` moves the root and every descendant. Conflicts are reported to the parent and remain in the JJ stack for normal resolution. After parent checks pass, calling `integrate_child` with `finalize: true` verifies no conflicts remain, forgets the child workspace, and removes its directory.

For Git delegation, Pi-Tai creates a managed worktree on `pi-tai/delegation/<name>` from parent `HEAD`. The child must commit intended changes and leave the worktree clean before reporting. Integration stages a non-squash merge with `--no-ff --no-commit`; conflicts remain visible for parent resolution, and finalization creates the merge commit only after verification.

`abandon_child` may terminate the process and forget/remove a clean workspace, but it never runs `jj abandon`, squashes history, deletes a Git child branch, or force-removes a dirty Git worktree. Dirty Git worktrees remain at their recorded recovery path.

There is intentionally no generic `cleanup_child` operation. A reported child process cleans up its own control channel, but its JJ workspace must remain available for integration and parent verification. Workspace cleanup is therefore explicit and disposition-specific: `integrate_child` with `finalize: true` after successful verification, or `abandon_child` when the parent chooses not to integrate.

## Durable state and recovery

Durable child state lives under:

```text
~/.pi/agent/pi-tai/subagents/
├── control/
├── delegations/
├── sessions/
└── logs/
```

Delegation records are atomically replaced under a per-delegation lock and include parent/child session IDs, process/log/control metadata, parent message history, workspace names and paths, base/root/tip change IDs, reports, conflicts, and lifecycle state.

If a process exits without `report_to_parent`, the launcher or later status reconciliation marks it failed. Child changes and workspace state remain available for diagnosis. `jj workspace update-stale` handles operation-ID drift before integration; missing or mismatched recorded roots fail rather than guessing at a replacement subtree.

## Capability-gated workspace backends

Workspace capabilities separate repository isolation from child orchestration so standalone agents can create or enter isolated checkouts without automatically spawning another agent. The test-first delivery record is defined in [WORKSPACE_CAPABILITIES_PLAN.md](WORKSPACE_CAPABILITIES_PLAN.md).

Product terminology distinguishes a generic Pi-Tai **workspace** from its backend-specific forms:

- a **JJ workspace**, managed by `jj workspace`;
- a **Git worktree**, managed by `git worktree`.

`SubagentOrchestrator` depends on a generic `WorkspacePort` rather than directly on `JjWorkspaceService`. Backend implementations remain separate:

```text
WorkspacePort
├── JjWorkspacePort
└── GitWorktreePort

SubagentPort
└── acquires one WorkspacePort backend
```

### Two workspace ownership models

Workspace allocation supports two deliberately different operating models:

| Invocation | Session role after creation | Runtime ownership | Completion path |
| --- | --- | --- | --- |
| Direct JJ-workspace or Git-worktree capability | `standalone` | The current logical agent moves to a successor Pi session whose cwd is the new workspace; a persisted source is forked, while a first-command source starts fresh | Normal standalone work; no parent callback or delegation integration |
| `spawn_child` from enabled subagents | Parent remains `parent`; new session is `child` | The detached child exclusively owns its workspace while the parent remains in the source workspace and pauses non-orchestration work | Child calls `report_to_parent`; parent waits, integrates or abandons, then finalizes |

The direct path must not create a `DelegationRecord`, expose `report_to_parent`, or make the source session an active orchestration parent. It creates a workspace-transition record, switches the active runtime to the new session/cwd, and preserves `standalone` role. A persisted source is forked with `SessionManager.forkFrom` and remains an immutable, resumable ancestor. When relocation is the first command and Pi has not flushed a source session file, Pi-Tai instead creates a brand-new persistent target session. In either case the target is operationally the same logical agent's **successor session**, not a Pi-Tai subagent.

The delegated path keeps the behavior enforced by the current implementation: `spawn_child` is the only parent operation that allocates a workspace, the child starts a distinct persistent RPC session in that path, parent messages travel through the durable child control channel, and the child reports back before terminating. Parent mode must reject direct workspace-transition tools and commands.

The corresponding session capabilities and model-facing tool families remain separate; Pi-Tai does not expose one ambiguous `create_workspace` tool. Tools are `create_jj_workspace`/`jj_workspace_status` and `create_git_worktree`/`git_worktree_status`. Terminal commands use the reserved capability namespace:

```text
/cap:jj-workspaces on|off|status
/cap:git-worktrees on|off|status
/cap:subagents on|off|status
```

Enabling subagents acquires one workspace backend as an internal dependency:

1. prefer JJ when the `jj` executable is available and the cwd belongs to a JJ repository;
2. otherwise use Git worktrees when `git` is available and the cwd belongs to a Git repository;
3. otherwise report subagents as unavailable.

An internal dependency lease makes the backend service available to `SubagentPort` but does **not** expose direct workspace-transition tools to the parent model. Direct user enablement in a standalone session acquires a separate tool-exposure lease. This distinction preserves the latest parent invariant: every parent-created workspace belongs to a child through `spawn_child`.

Fallback is decided before creating anything. A failed or partially completed JJ operation must not silently retry through Git and leave mixed repository state. Direct standalone commands select their explicit namespace; subagents use automatic JJ-first selection. Capability dependency ownership must also be tracked: disabling subagents releases its internal backend lease, but must not disable a workspace capability the user enabled independently.

Git records use backend-appropriate durable linkage: repository identity, base commit, branch/ref, worktree path, and reported tip commits. Cleanup preserves branches, commits, and uncommitted files unless an explicit destructive operation is separately authorized. Integration uses a reviewed non-squash merge and never imitates JJ change-ID semantics.

### Standalone workspace behavior

A standalone agent may create a JJ workspace or Git worktree for inspection/staging without moving, or request a direct transition that continues work there. Creation always returns and records the absolute path. A create-only operation leaves the current Pi session unchanged; a create-and-enter operation replaces the session so the rebuilt runtime's cwd is the new path while its role remains `standalone`. Persisted context is forked; a first-command invocation creates a fresh target session.

Pi's tools, resource discovery, project trust, and extension context are bound to the cwd used to construct `AgentSessionRuntime`. Running `cd` in one shell command or calling `process.chdir()` would not safely rebind those services.

Pi already exposes the primitives for a real transition. `SessionManager.forkFrom(sourceSessionFile, targetCwd)` creates a new persistent session with a new ID and target-cwd header, links the old file as `parentSession`, and copies the old session entries. For a first-command relocation with no flushed source file, `SessionManager.create(targetCwd, sessionDir)` provides the fresh target instead. An extension command can then call `ctx.switchSession(newSessionFile)`; `AgentSessionRuntime` shuts down the old session, rebuilds cwd-bound services and resources, rebinds extensions, and starts the copied session in the workspace. Code after replacement must use only the fresh `withSession` context.

The capability offers these distinct flows:

- create the workspace and return its path without moving the standalone agent;
- create-and-enter by forking the standalone session into the workspace and switching through a `/cap:` extension command;
- enable subagents and let `spawn_child` allocate a workspace for a separate child session;
- in hosted direct-transition operation, keep the stable broker session ID while atomically remapping it to the successor Pi session ID/file and cwd; hosted delegation instead creates a separately identified child broker/Pi session with a callback relationship.

Model-callable tools cannot directly perform session replacement because they receive `ExtensionContext`, not `ExtensionCommandContext`. They may prepare a workspace, but the actual transition belongs to an extension command or typed Host operation. The transition must be rejected while unresolved child delegations or other feature state cannot be safely rebound. Copied work context and extension entries reconstruct normally; features keyed by the old Pi session ID need explicit migration or reset policy.

Standalone JJ workspaces are rooted above source `@-` and live under `<repo>/.jj/workspaces/<name>`. Git worktrees live under `~/.pi/agent/pi-tai/workspaces/git/<repo-key>/<workspace-id>` or the injected hosted agent-data root. This avoids untracked nested worktrees; every path is recorded durably and returned in capability and subagent results.
