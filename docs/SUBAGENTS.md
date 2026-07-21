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
