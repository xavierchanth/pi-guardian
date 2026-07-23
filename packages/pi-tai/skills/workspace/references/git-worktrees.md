# Git linked worktrees

A linked worktree is another checkout attached to the same Git repository. Worktrees share commits and most refs, while each has its own working tree, index, `HEAD`, and per-worktree administrative state.

## Create safely

Inspect and state the source, destination, and base before mutation:

```bash
git rev-parse --show-toplevel
git status --short
git rev-parse --verify HEAD
git worktree list --porcelain
```

Uncommitted source changes are not included: a new worktree starts from a commit. Do not stash, reset, clean, or commit source changes to manufacture a base.

Use an explicit path and base. Common forms are:

```bash
# New branch
git worktree add -b <new-branch> <path> <base>

# Existing branch
git worktree add <path> <existing-branch>

# Detached checkout
git worktree add --detach <path> <commit>
```

A local branch normally cannot be checked out in two worktrees. Do not bypass that protection with force, replace an existing branch with `-B`, or guess another branch. Detached mode is appropriate only when requested or when no branch should move; explain that detached commits need a branch or tag before cleanup if they must be retained.

If creation partly succeeds, preserve the worktree and refs and inspect them rather than forcing another add.

## Work in the worktree

Creating a worktree does not change the caller's persistent cwd. Run commands with `<path>` as cwd and direct file operations there. Always verify `git status --short --branch` and `git rev-parse HEAD` in that path before editing.

Changes can span multiple commits. Inspect the complete range and working tree rather than assuming one commit.

## Integrate deliberately

Git does not have one universal “integrate” operation. Ask which history and destination the user wants, then choose an ordinary Git operation such as merge, rebase, cherry-pick, or a fast-forward/bookmark-like branch update as appropriate. Inspect source and destination histories first. Do not squash, rewrite, or discard history without explicit authorization.

Do not perform integration from a dirty destination or solve that by stashing/resetting it. On conflict or partial operation, stop, preserve both worktrees and Git's operation state, and report it; do not force, reset, or abort automatically.

Detached commits are not retained by a branch merely because their worktree exists. Before removing a detached worktree, show commits not reachable from durable refs and create a branch/tag only with user approval.

## Remove and retain branches

Only remove a clean, verified worktree that the user no longer needs:

```bash
git worktree remove <path>
```

Do not use `--force`. Removing a worktree does not delete its branch; retain the branch by default. Branch deletion is a separate, explicit decision after verifying reachability/integration. Never manually delete worktree administrative directories.

## Maintenance and recovery

- `git worktree lock <path>` protects a worktree that may be temporarily unavailable (for example, on removable storage); `unlock` reverses it.
- `git worktree prune --dry-run` previews stale administrative entries. Prune only after verifying the corresponding directories are truly gone; do not treat it as worktree removal.
- After a linked worktree or repository directory was moved outside Git, use `git worktree repair` with the relevant paths and verify `git worktree list --porcelain`.

Run maintenance from a known valid worktree and preserve data on uncertainty. The main worktree cannot be moved or removed with `git worktree move/remove`; linked worktrees have their own per-worktree `HEAD` and index but do not own repository-wide refs or configuration. Check command documentation before any repository-wide operation from a linked worktree.

Git documents multiple-checkout support for repositories with submodules as incomplete. Avoid creating linked worktrees containing initialized submodules unless the user accepts the limitation; inspect and handle submodules separately rather than forcing cleanup.

## Colocated JJ repositories

An explicit request for Git or the phrase `git worktree` selects this strategy even when `jj root` succeeds. This override must be established before mutation. A mere statement that the repository is Git-backed does not select Git.

In a colocated JJ/Git repository, the linked Git worktree is not a JJ workspace, and the main JJ checkout may remain on detached Git `HEAD`. A branch created in the linked Git worktree can later be imported as a JJ bookmark, but Git branch updates may not match JJ bookmarks until JJ imports Git refs; imported branches can appear as tracking bookmarks, conflicts, or divergent state. Do not run JJ import/export or move bookmarks automatically. Report that caveat and let the user choose synchronization. Once Git worktree mutation starts, never switch to the JJ workspace strategy.

## Safe stop conditions

Stop on dirty integration targets, branch checkout conflicts, unexpected refs, detached commits at risk, submodule complications, partial operations, failed verification, or uncertain path ownership. Preserve files and refs; report paths, `git status`, `git worktree list --porcelain`, and focused logs before asking how to proceed.
