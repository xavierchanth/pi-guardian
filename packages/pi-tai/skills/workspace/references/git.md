# Git worktree fallback

Use this strategy only when `jj root` failed before any workspace mutation. Never fall back to Git after a JJ mutating command was attempted.

## Invariants

- Preserve source files and history.
- Never force-clean, reset, stash, or discard source work to satisfy a precondition.
- Record the source path, base commit, managed branch, worktree name, and worktree path.
- Never assume isolated work produces exactly one commit.
- Preserve both worktrees on conflict, partial integration, cleanup failure, or uncertainty.

## Create

Unlike JJ's working-copy revisions, Git cannot safely derive an independent committed base from uncommitted source changes without stashing or committing them. Do neither automatically.

1. Inspect:

```bash
git rev-parse --show-toplevel
git status --short
git rev-parse HEAD
git worktree list --porcelain
```

2. Record the repository root and `HEAD` as the base commit. Source uncommitted changes may remain in the source checkout; the new worktree starts from recorded `HEAD` and does not include them.
3. Choose a lowercase task-oriented name and a managed branch that does not already exist.
4. Create the worktree:

```bash
git worktree add -b <branch> <path> <base-commit>
```

5. Verify its branch and `HEAD`, then report the source path, base commit, branch, and destination.

If allocation partly succeeds and verification fails, preserve the branch and worktree and stop.

## Work from or enter the worktree

Creating a worktree does not change Pi's persistent session cwd. For current-turn work, prefix shell commands with `cd <path> &&` and target all file tools beneath the worktree path.

If the user wants a persistently relocated interactive session and no relocation tool is available, report:

```bash
cd <path> && pi
```

Do not launch a nested interactive Pi process from a non-interactive tool call.

## Integrate

1. Require all delegated changes to be committed and the isolated worktree clean.
2. Inspect the complete commit range from the recorded base to the managed branch.
3. Merge without squashing or otherwise discarding history.
4. On any conflict or partial merge, stop and preserve both worktrees. Do not reset or abort merely to make integration easier.
5. Verify the resulting history contains the complete delegated range.

## Cleanup

Remove the worktree only after verified integration and only while it is clean:

```bash
git worktree remove <path>
```

Do not force removal. Delete a managed branch only when its integration is verified and the user requested that cleanup.
