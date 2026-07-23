---
name: workspace
description: Create, enter, inspect, integrate, or clean up an isolated workspace or worktree. Use whenever the user asks for a workspace, work tree, worktree, isolated checkout, or asks to avoid interfering with work in the main working directory.
---

# Workspace router

Choose exactly one strategy before any workspace mutation:

1. If the user explicitly requests Git or says `git worktree`, read [references/git-worktrees.md](references/git-worktrees.md) completely and use Git—even in a JJ or colocated repository.
2. Otherwise, probe with `jj root` in the current directory. If it succeeds, read [references/jj-workspaces.md](references/jj-workspaces.md) completely and use JJ.
3. If that probe fails, read [references/git-worktrees.md](references/git-worktrees.md) completely and use Git.
4. A statement that the repository is Git-backed is not by itself an explicit Git override. Never switch strategies after mutation starts.

A generic workspace/worktree request authorizes routine read-only inspection and creation of an isolated workspace. It does not authorize deleting, abandoning, undoing, rewriting, or simplifying existing work.
