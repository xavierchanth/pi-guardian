---
name: workspace
description: Create, enter, inspect, integrate, or clean up an isolated workspace or worktree. Use whenever the user asks for a workspace, work tree, worktree, isolated checkout, or asks to avoid interfering with work in the main working directory.
---

# Workspace router

Treat “workspace”, “work tree”, and “worktree” as equivalent triggers. Load exactly one backend strategy before taking workspace action:

1. Probe with `jj root` in the current working directory.
2. If it succeeds, read [references/jj.md](references/jj.md) completely and follow it. Do not inspect or use the Git fallback.
3. If it fails, and only before any JJ mutation was attempted, read [references/git.md](references/git.md) completely and follow it.
4. Never switch backends after mutation begins.

A request to work “from a workspace” or avoid the “main thread” authorizes routine read-only repository inspection and creation of an isolated workspace for that task. It does not authorize deleting, abandoning, undoing, or simplifying existing work.
