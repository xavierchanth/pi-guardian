# JJ workspaces

A JJ workspace is a working directory with its own working-copy commit (`@`). All workspaces share the repository's commit graph, bookmarks, and operation history, but each workspace has an independent checkout, sparse patterns, and workspace target.

## Create safely

Inspect before changing anything:

```bash
jj root
jj status
jj workspace list
jj log -r '@ | parents(@)' --no-graph
```

Choose and state an explicit name and path. The ordinary isolated-work default is:

```bash
jj workspace add <path> --name <name>
```

This creates a sibling working-copy commit based on the current workspace's parent(s); changes in the current `@` are not copied. If `@` has multiple parents, explain that the new workspace preserves that multi-parent base rather than selecting one parent arbitrarily.

Only when the user explicitly asks to include the current working-copy change, specify it:

```bash
jj workspace add <path> --name <name> -r @
```

An explicit requested base can likewise be passed with `-r <revision>`. Do not invent a revision when the request is ambiguous.

Creation can snapshot the current workspace before the command runs. Snapshotting records its filesystem state in its existing working-copy commit; it is not permission to rewrite, abandon, or move that work. After creation, verify with `jj workspace list` and inspect `@` and its parents from the new path.

Workspace names, filesystem paths, Change IDs, and commit IDs are different things. Record the name and path. Use stable Change IDs when tracking a logical change across normal rewrites, but check for divergent Change IDs before acting.

## Work in the workspace

Creating a workspace does not change the caller's persistent cwd. Run commands with the new path as cwd and direct file operations there. Do not claim a one-shot `cd` moved the surrounding session.

Each workspace has its own sparse patterns. Inspect before altering them:

```bash
jj sparse list
```

Use `jj sparse set ...` only when the user requested a sparse checkout and after reviewing `jj sparse set --help`; changing patterns updates that workspace's checkout and can snapshot first.

JJ snapshots tracked filesystem changes when commands inspect or mutate the working copy. A workspace's `@` is a real, workspace-specific commit and may be rewritten as files change. Do not assume a task is one change: users can create and edit a multi-change history with `jj new`, `jj edit`, and other normal operations.

## Shared graph and integration

Because workspaces share one graph, commits created in one are already visible from every other workspace. “Integrate” therefore means arranging history or moving bookmarks as the user requests—not copying commits between repositories. Inspect the complete relevant history and diffs first. Never assume one tip or one change, and do not rewrite unrelated workspace targets.

Conflicts are first-class JJ commits and may be visible after a rebase or other rewrite. Divergent changes may make a Change ID resolve to multiple commits. On unexpected conflicts, divergence, ambiguous revisions, an unexpected graph, or a partial operation, stop mutation, preserve all workspaces and operation history, and report the state. Do not choose a divergent side or parent, run `jj undo`, or abandon changes automatically.

## Stale workspaces and recovery

A workspace can become stale when shared operations rewrite its working-copy commit elsewhere. In that workspace, inspect first, then use:

```bash
jj workspace update-stale
```

This may create a recovery commit containing un-snapshotted filesystem changes. Inspect and retain any recovery history; never discard it automatically. If the workspace directory is gone but its record remains, `jj workspace forget <name>` removes only the workspace record. It does not delete files. Conversely, deleting a directory does not reliably forget the workspace.

## Rename, move, and remove

Rename the workspace identity from inside that workspace:

```bash
jj workspace rename <new-name>
```

Renaming is not moving: relocate the directory separately only after ensuring commands are idle, preserve its `.jj` metadata, then verify `jj root`, `jj status`, and `jj workspace list` from the new path. If verification fails, preserve both filesystem state and repository metadata and stop.

For cleanup, first inspect status/history and obtain confirmation that the workspace is no longer needed. `jj workspace forget <name>` only unregisters it; filesystem deletion is a separate action. Never recursively delete a path unless its identity, location, and disposability have been verified. Do not abandon its commits merely because the workspace is removed.

## Colocated repositories

In a colocated JJ/Git repository, generic workspace requests still use JJ. A JJ workspace shares JJ's graph, including Git-tracking bookmarks, but it is not interchangeable with a linked Git worktree; Git's index, checkout rules, and ref view differ. Git ref import/export can move bookmark state and may expose conflicts or divergent bookmarks. Do not run Git worktree commands or import/export refs merely to make a JJ workspace. Use the Git strategy only when the user explicitly requested Git/`git worktree` before mutation.

## Safe stop conditions

Stop and preserve data on stale recovery you do not understand, conflicts, divergence, ambiguous revisions, unexpected parents, failed verification, partial creation/removal, or any uncertainty about path ownership. Report workspace names and paths, `jj status`, `jj workspace list`, a focused `jj log`, and recent `jj op log`; ask the user before further mutation.
