---
name: workspace
description: Create, enter, inspect, integrate, or clean up an isolated JJ workspace. Use whenever the user asks for a workspace, work tree, worktree, isolated checkout, or asks to avoid interfering with work in the main working directory.
---

# Workspace router

Treat “workspace”, “work tree”, and “worktree” as equivalent triggers. Pi-Tai supports Jujutsu workspaces only.

## Isolated implementation delegation

Only the root thinker may create a workspace for a child. For isolated implementation, call `workspace_subagent` with a self-contained task packet and choose:

- `planner` for substantial work that needs decomposition or child coordination;
- `worker` for bounded implementation.

The thinker may launch as many independent workspace children as useful. Planners, workers, and other children must never create workspaces recursively. After a workspace child completes and its result is collected, call `integrate_workspace`; do not implement its assignment inline.

## Direct lifecycle administration

Explicit requests to inspect, create, enter, integrate, forget, remove, or clean up workspace state are lifecycle administration. Read [references/jj.md](references/jj.md) completely and follow it. Do not probe or fall back to Git.

A request to work “from a workspace” authorizes routine read-only inspection and workspace creation. It does not authorize abandoning unrelated work.

Manual `/skill:workspace` invocation forces this router to load but does not bypass root-only delegated-workspace authority or the deterministic JJ procedure.
