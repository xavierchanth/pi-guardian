# Pi-Tai subagents

Pi-Tai provides opt-in, two-tier delegation backed by persistent Pi sessions and Jujutsu workspaces. It is disabled by default and has no configuration UX in this pass.

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

- `/sub-agents` or `/sub-agents on`: enable the parent role for this session;
- `/sub-agents status`: show role and child counts;
- `/sub-agents off`: return to standalone after every child is resolved.

Parent tools:

- `spawn_child`: create and launch one bounded child task;
- `wait_for_children`: block without parent LLM calls until the uncollected child snapshot resolves;
- `child_status`: inspect one or all direct children;
- `integrate_child`: rebase a completed child subtree, then separately finalize after verification;
- `abandon_child`: stop the child and remove its workspace without abandoning JJ changes.

Child tool:

- `report_to_parent`: persist `completed`, `blocked`, `failed`, or `cancelled`, capture the child tip change ID, wake parent waiting, and terminate the child run.

## Semantic model preferences

`spawn_child` selects intent rather than an arbitrary provider/model pair:

| ID | Intended work | Provider/model | Effort |
| --- | --- | --- | --- |
| `thinker` | Investigation, planning, architecture, substantial judgment | `openai-codex/gpt-5.6-sol` | high |
| `worker` | Planned work requiring trusted engineering judgment | `openai-codex/gpt-5.6-sol` | low |
| `mechanical` | Explicit repetitive transformations | `openai-codex/gpt-5.6-luna` | high |

The launcher starts `pi --mode json` with only the Pi-Tai extension, a persistent session, the selected model and effort, and the child workspace as its working directory. Output is retained beside the delegation records.

## JJ topology

Before spawning, the parent working copy `@` must have no file changes. Pi-Tai captures:

- the current parent workspace name;
- parent `@-` as `baseChangeId`;
- the new child workspace `@` as `childRootChangeId`.

It creates the workspace with:

```sh
jj workspace add <path> --name <name> -r <baseChangeId>
```

This creates the child's initial working-copy change above the base. Durable linkage uses change IDs, never commit IDs.

Before integration, Pi-Tai updates a stale child workspace and verifies that child `@` still descends from the recorded root. It then runs from the parent workspace:

```sh
jj rebase -s <childRootChangeId> -B <parentWorkspace>@
```

`-s` moves the root and every descendant. Conflicts are reported to the parent and remain in the JJ stack for normal resolution. After parent checks pass, calling `integrate_child` with `finalize: true` verifies no conflicts remain, forgets the child workspace, and removes its directory.

`abandon_child` may terminate the process and forget/remove the workspace, but it never runs `jj abandon` or squashes the child's changes.

## Durable state and recovery

Durable child state lives under:

```text
~/.pi/agent/pi-tai/subagents/
├── delegations/
├── sessions/
└── logs/
```

Delegation records are atomically replaced under a per-delegation lock and include parent/child session IDs, process/log metadata, workspace names and paths, base/root/tip change IDs, reports, conflicts, and lifecycle state.

If a process exits without `report_to_parent`, the launcher or later status reconciliation marks it failed. Child changes and workspace state remain available for diagnosis. `jj workspace update-stale` handles operation-ID drift before integration; missing or mismatched recorded roots fail rather than guessing at a replacement subtree.

## Roadmap: capability-gated workspace backends

The implemented subagent system remains JJ-only. A future workspace capability separates repository isolation from child orchestration so standalone agents can also create and inspect isolated checkouts without automatically spawning another agent.

Product terminology distinguishes a generic Pi-Tai **workspace** from its backend-specific forms:

- a **JJ workspace**, managed by `jj workspace`;
- a **Git worktree**, managed by `git worktree`.

The extension-facing `SubagentPort` should depend on a generic `WorkspacePort` rather than directly on `JjWorkspaceService`. Backend implementations remain separate:

```text
WorkspacePort
├── JjWorkspacePort
└── GitWorktreePort

SubagentPort
└── acquires one WorkspacePort backend
```

The corresponding session capabilities and model-facing tool families also remain separate; the first pass should not expose one ambiguous `create_workspace` tool. Draft tools include `create_jj_workspace`/`jj_workspace_status` and `create_git_worktree`/`git_worktree_status`, with backend-specific cleanup and integration operations added only after their safety contracts are defined. Draft terminal commands use the reserved capability namespace:

```text
/cap:jj-workspaces on|off|status
/cap:git-worktrees on|off|status
/cap:subagents on|off|status
```

Enabling subagents acquires one workspace capability as a dependency:

1. prefer JJ when the `jj` executable is available and the cwd belongs to a JJ repository;
2. otherwise use Git worktrees when `git` is available and the cwd belongs to a Git repository;
3. otherwise report subagents as unavailable.

Fallback is decided before creating anything. A failed or partially completed JJ operation must not silently retry through Git and leave mixed repository state. Explicit backend selection may be added later. Capability dependency ownership must also be tracked: disabling subagents releases an automatically acquired workspace capability, but must not disable a capability the user enabled independently.

Git records need backend-appropriate durable linkage: repository identity, base commit, branch/ref, worktree path, and reported tip commits. Cleanup must preserve branches, commits, and uncommitted files unless an explicit destructive operation is separately authorized. Git integration policy—merge, rebase, or cherry-pick—remains a later design decision and must not imitate JJ change-ID semantics.

### Standalone workspace behavior

A standalone agent may create a JJ workspace or Git worktree for inspection, staging, or a future session. Creation always returns and records the absolute path. It does **not** change the current Pi session's cwd.

Pi's tools, resource discovery, project trust, and extension context are bound to the cwd used to construct `AgentSessionRuntime`. Running `cd` in one shell command or calling `process.chdir()` would not safely rebind those services. Work intended to execute inside the new workspace therefore uses one of these flows:

- spawn a child whose new Pi session starts with the workspace path as cwd;
- start a separate terminal Pi session from the returned path;
- in hosted operation, ask the Host to create a new broker session/runtime attached to that path.

A future explicit workspace/session transition may replace the active runtime, but it should be modeled as session replacement rather than an ordinary tool changing cwd in place.

JJ workspaces continue to live under `<repo>/.jj/workspaces/<name>`. The provisional standalone Git location is the Pi-Tai managed data root, such as `~/.pi/agent/pi-tai/workspaces/git/<repo-key>/<workspace-id>`; the Host uses its platform application-data equivalent. The final path policy must avoid untracked nested worktrees, record every path durably, and return it in capability and subagent results.
