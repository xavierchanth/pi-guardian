# JJ workspace strategy

Use this strategy whenever `jj root` succeeds. A JJ workspace has its own directory and working-copy revision but shares the repository graph and operation history.

## Invariants

- Creating an isolated workspace must not require the source `@` to be empty.
- Create the isolated workspace from the source `@-`, so uncommitted work already represented by the source `@` remains only in the source workspace.
- Creation may snapshot JJ working-copy state as part of a normal JJ operation, but it must not rewrite, discard, move, or edit source files.
- Record Change IDs, not commit IDs. Change IDs survive ordinary rewrites.
- Never assume the isolated task produces exactly one change.
- Never checkpoint, abandon, undo, restore, simplify, or rewrite existing work merely to satisfy a precondition.
- On an unexpected graph, divergence, stale recovery, conflict, partial operation, or suspected mistake, preserve files, workspaces, and operation history. Stop JJ mutation and ask the user to intervene.

## Create

A request to work from a workspace, work tree, or worktree authorizes this routine repository inspection and workspace creation.

1. Choose a lowercase task-oriented name containing only letters, numbers, and hyphens.
2. Inspect and record the source without changing its files:

```bash
jj root
jj status
jj workspace list -T 'name ++ "|" ++ target.change_id() ++ "\n"'
jj log -r '@ | @-' --no-graph -T 'workspace: ++ workspace_name ++ "\nchange: " ++ change_id ++ "\ncommit: " ++ commit_id ++ "\ndescription: " ++ description.first_line() ++ "\n\n"'
jj diff -r @ --summary
```

3. Record:
   - repository root;
   - source workspace name;
   - source `@` Change ID;
   - base `@-` Change ID;
   - whether source `@` currently contains work.
4. Require `@-` to identify one revision. A merge working copy or ambiguous/divergent Change ID requires user attention; do not choose a parent arbitrarily.
5. Create the destination directory under `<repo-root>/.jj/workspaces/<name>` and add the workspace from the recorded base:

```bash
jj workspace add <destination> --name <name> -r 'exactly(change_id(<base-change-id>), 1)'
```

The expected graph is:

```text
recorded base
├── source @       # may contain the user's ongoing work
└── isolated root  # new workspace working-copy revision
```

6. In the new workspace, record its `@` Change ID as the isolated root and verify that its sole parent has the recorded base Change ID:

```bash
cd <destination> && jj log -r '@ | @-' --no-graph -T 'change_id ++ "\n"'
```

7. Report the destination, source workspace, source Change ID, base Change ID, isolated root Change ID, and whether the current Pi session remains rooted in the source directory.

If creation allocated a workspace but later verification fails, preserve it. Report the name and path; do not forget or delete it automatically.

## Work from or enter the workspace

Creating a workspace does not itself change Pi's persistent session cwd. Never claim that a one-shot shell `cd` moved the session.

For work in the current turn:

- use the destination as the explicit cwd for every shell command, for example `cd <destination> && ...`;
- use paths under the destination for read, write, edit, grep, and find;
- do not perform the delegated task against source-workspace paths.

If the user asks for a persistently relocated interactive session and no relocation tool is available, report the exact command they can use to start one:

```bash
cd <destination> && pi
```

Do not launch a nested interactive Pi process from a non-interactive tool call.

## Inspect before integration

Integration is separate from creation. Do not integrate until the user asks or the owning managed planner has completed.

Retain the recorded source workspace, base Change ID, isolated root Change ID, workspace name, and path. Before mutation:

1. Read the source and isolated workspace targets with `--ignore-working-copy`.
2. Run `jj workspace update-stale` in the isolated workspace and source workspace.
3. Read both target Change IDs again. If stale update creates recovery history, changes a workspace to an unexpected Change ID, or produces an unexpected graph, stop.
4. Require the source workspace's current working-copy revision to be empty before insertion:

```bash
jj diff -r '<source-workspace>@' --summary
```

The source was allowed to be dirty during creation and isolated work. This integration precondition prevents rewriting a live source working copy while inserting the isolated subtree. Ask the user to finish or checkpoint that source work and leave a fresh empty source `@`; never do it for them.

## Validate the complete subtree

Define:

```text
root   = exactly(change_id(<isolated-root-change-id>), 1)
base   = exactly(change_id(<base-change-id>), 1)
source = <source-workspace>@
child  = <isolated-workspace>@
```

Verify all of the following:

1. `root` resolves to exactly one visible revision.
2. `root` is an ancestor of `child`.
3. `root` has exactly the recorded `base` as its parent.
4. `root:: ~ ::child` is empty, so the rooted subtree has no descendants outside the isolated workspace's ancestry.
5. The complete subtree and diff have been inspected; its size was not inferred.

Any mismatch requires user intervention.

## Integrate

Insert the complete isolated subtree before the source workspace's empty working-copy revision:

```bash
jj rebase -s 'exactly(change_id(<isolated-root-change-id>), 1)' -B '<source-workspace>@'
```

Then verify that the recorded root is an ancestor of `<source-workspace>@` and inspect conflicts:

```bash
jj resolve --list -r '<source-workspace>@'
```

On any conflict, mismatch, partial result, or uncertainty, stop. Do not resolve, undo, abandon, or run another rebase.

## Cleanup

Only after verified conflict-free integration:

```bash
jj workspace forget <workspace-name>
```

Then remove the workspace directory. If forgetting or removal fails, preserve what remains and stop.

## Failure report

Report, without attempting repair:

- source and isolated paths and workspace names;
- recorded source, base, root, and tip Change IDs;
- the exact failed command and output;
- `jj status` in each accessible workspace;
- a focused `jj log` showing the recorded revisions and workspace targets;
- `jj op log -n 10 --no-graph`.
