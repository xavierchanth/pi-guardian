# JJ workspace strategy

Pi-Tai supports only Jujutsu workspaces.

## Invariants

- Create an isolated workspace from source `@-`; source `@` may contain active work.
- Record Change IDs and the source workspace path.
- Never require source `@` to be empty.
- Preserve source `@`'s Change ID and file content. Inserting delegated changes may rewrite its commit ID and parent and make its checkout stale.
- Only the root thinker creates delegated workspaces.
- Update stale in both source and delegated workspaces before integration.
- Deterministic code owns graph validation, workspace forgetting/removal, empty-revision stripping, rebasing, and conflict detection.
- The thinker owns semantic descriptions after integration.

## Create

Inspect the source and record its repository root, workspace name/path, `@` Change ID, and `@-` Change ID. Require `@-` to resolve uniquely. Create beneath `<repo-root>/.jj/workspaces/`:

```bash
jj workspace add <destination> --name <name> -r 'exactly(change_id(<base-change-id>), 1)'
```

Verify the new workspace root has the recorded base as its sole parent. Creation must not move, rewrite, discard, or edit source files.

## Work in the workspace

Use the workspace path explicitly for every file and command operation. Creating a workspace does not relocate the interactive Pi session.

## Integrate delegated work

Managed integration performs this sequence in code:

1. Run `jj workspace update-stale` in the delegated workspace and source workspace.
2. Reject recovery output, divergent identities, an unexpected base/root/head relationship, or descendants outside the delegated ancestry.
3. Capture the source, base, root, head, and complete delegated range by Change ID.
4. Classify every delegated revision as empty or nonempty.
5. Forget the delegated workspace and remove its directory. Repository revisions remain available.
6. Abandon every empty delegated revision using `--ignore-working-copy`.
7. Rebase all remaining delegated revisions before the recorded source Change ID, preserving dependencies:

```bash
jj --ignore-working-copy rebase -r '<nonempty-change-id-union>' -B 'exactly(change_id(<source-change-id>), 1)'
```

8. Verify every retained Change ID is an ancestor of the source Change ID and inspect conflicts.
9. Return retained and undescribed Change IDs to the thinker.

An entirely empty delegated range is a successful cleanup-only integration. Source files are not updated by the graph rewrite; another process using that checkout can run `jj workspace update-stale` when ready.

## Describe retained changes

After integration, the thinker inspects each undescribed retained change and calls `describe_integrated_changes` with meaningful Conventional Commit descriptions. The tool applies exact Change-ID descriptions and verifies them; no retained change may remain undescribed before completion.

## Failure handling

On an unexpected graph, stale recovery, conflict, or partial operation, stop further JJ mutation and report:

- source and delegated workspace identities and paths;
- recorded base, root, head, and source Change IDs;
- whether the delegated workspace was already forgotten and removed;
- the exact failed command and output;
- a focused `jj log` and `jj op log -n 10 --no-graph`.

Do not automatically undo, retry a rebase, or resolve conflicts.
