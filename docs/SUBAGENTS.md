# Pi-Tai declarative subagents

Pi-Tai provides opt-in nested delegation through persistent isolated Pi processes. Normal subagents share the caller's working directory; thinker may instead launch exactly one planner in a recorded isolated workspace. No child inherits its parent's conversation.

## Activation

```text
/subagents
/subagents on
/subagents status
/subagents list [delegation-id]
/subagents off
```

Subagents are disabled by default. Bare `/subagents` toggles the capability. `on` resolves the effective root definition, validates its model and tools, snapshots the current model/effort/tools, and applies the root definition to the main session. `off` is rejected while direct children are unresolved and otherwise restores that snapshot. `force-off` recursively terminates unresolved direct children and descendants, leaves shared files untouched, then restores the snapshot. No workspace capability is probed or leased.

New and ordinary forked sessions start standalone. Delegated processes reconstruct their child identity from the durable delegation record and environment-bound delegation ID.

## Agent definitions

Definitions are non-recursive Markdown files loaded in this precedence order:

1. trusted nearest-project `.pi/agents/*.md`;
2. user `~/.pi/agent/agents/*.md`;
3. packaged `packages/pi-tai/agents/*.md`.

Higher scopes override by `name`. Untrusted project definitions are ignored. Each effective catalog must have exactly one `root: true` definition, resolve every allowed child, and contain no child graph cycles.

```markdown
---
name: worker
description: Implements bounded engineering tasks
model: openai-codex/gpt-5.6-sol
effort: low
tools:
  - read
  - write
  - edit
  - grep
  - find
  - ls
  - bash
  - update_plan
  - subagent
  - message_child
  - wait_for_children
  - child_status
  - respond_to_child
  - abandon_child
allowed-children:
  - scout
  - researcher
uncertainty-handling: ask-parent
---

Persistent role instructions go here.
```

The front matter is strict. Unknown fields, duplicate tools, malformed names, missing child definitions, and unavailable tools fail before launch. A definition must declare both `subagent` and at least one allowed child, or neither. Delegated protocol tools (`report_to_parent` and `ask_parent`) are injected by the child runtime rather than repeated in every definition.

Packaged hierarchy:

```text
thinker
├── planner
│   ├── worker
│   │   ├── scout
│   │   └── researcher
│   ├── scout
│   └── researcher
├── scout
└── researcher
```

`thinker` and `planner` use Sol high, `worker` uses Sol low, `scout` uses Luna medium, and `researcher` uses Terra medium. Thinker may delegate to a planner, scout, or researcher. Planner may delegate to a worker, scout, or researcher. Worker may delegate only to scouts or researchers. Only thinker owns planner-workspace tools; planner can never launch a planner or create a workspace. The validated child graph contains no self-edges or cycles, so delegation depth is structurally bounded. Thinker, planner, and researcher explicitly receive `web_search` and `web_fetch`; worker and scout do not. Standalone sessions retain both as normal Pi-Tai tools.

## Sparse task ingest

The model-facing request selects one allowed agent and supplies a structured packet:

```ts
interface TaskPacket {
  objective: string;
  context?: string[];
  resources?: Array<{
    type: "file" | "directory" | "url" | "commit";
    value: string;
    reason?: string;
  }>;
  constraints?: string[];
  acceptanceCriteria?: string[];
  expectedOutput?: string;
  uncertaintyHandling?: "best-effort" | "block" | "ask-parent";
}
```

The extension renders stable objective, context, resource, constraint, acceptance, output, and uncertainty sections. Files are passed by reference. Parent conversation messages are never copied. The selected definition supplies persistent operating procedure; the packet supplies task-specific intent and boundaries.

Uncertainty resolution order is task override, then role default, then `block`:

- `best-effort`: make the safest reasonable assumption and disclose it;
- `block`: terminate with a structured blocked report rather than guess;
- `ask-parent`: persist a correlated question and wait for `respond_to_child`.

## Runtime isolation

A child launches with:

- its snapshotted definition and prompt;
- exact provider/model and effort;
- exact declared built-in/custom tools;
- only the Pi-Tai child runtime, work-context and web tools, and Guardian;
- a private persistent session, FIFO control channel, and JSONL log;
- the direct parent's cwd for normal subagents, or a recorded isolated workspace for `planner_workspace`;
- no skills, unrelated extensions, or conversation history.

The role snapshot includes source path and content hash, so edits affect future launches without silently widening a running child's authority. Nested workers receive only their own allowed descendant names and must compile fresh sparse packets.

Because cwd is shared for normal delegation, the packaged planner and worker prompts require narrow assignments, reading and re-reading before writes, preservation of unrelated changes, and validation after mutation. Parent and child processes may work concurrently; Pi-Tai does not pause the parent or serialize writers, so callers remain responsible for sensible task partitioning and avoiding duplicate work.

## Workspace policy

This operating model follows JJ 0.43 command help and the official [working-copy](https://docs.jj-vcs.dev/latest/working-copy/), [revset](https://docs.jj-vcs.dev/latest/revsets/), and [operation-log](https://docs.jj-vcs.dev/latest/operation-log/) documentation. In particular, each workspace has its own working-copy commit, cross-workspace rewrites can make a working copy stale, Change IDs survive rewrites unless they diverge, and the operation log preserves concurrent repository operations.

Workspace and worktree backends are not session capabilities. The packaged generic `workspace` skill is visible for automatic model matching when the user asks for a workspace, work tree, worktree, isolated checkout, or non-interference with the main working directory. An explicit request for Git or `git worktree` loads the Git linked-worktree reference even in a JJ/colocated repository. Otherwise its small `SKILL.md` probes JJ and loads the JJ workspace reference when available, falling back to Git only before mutation. It never changes backend after mutation starts. `/skill:workspace` remains available to force loading but is not required. The generic backend references are independent of the managed planner lifecycle below.

Subagent workspace use is narrower: only thinker may call `planner_workspace`, and that tool always launches the `planner` definition. Creation does not require an empty source working-copy change: the isolated root branches from recorded `@-`, leaving source `@` and its files in place. Integration also permits concurrent work in source `@`: it inserts the complete delegated subtree between the recorded base and the same source working-copy change, preserving the source workspace identity, current marker, and on-disk files. The durable record stores the backend attachment, source workspace and current Change ID, base Change ID or commit, delegated root Change ID or branch, path, and one exclusive phase:

- `active`: planner work is isolated and not integrated;
- `integrated`: the complete recorded subtree/range was integrated without detected conflicts;
- `cleaned`: the integrated workspace was forgotten and removed;
- `attention_required`: integration or cleanup encountered uncertainty and is permanently stopped for user intervention.

For JJ, creation makes the delegated root a sibling of the potentially dirty source working-copy change over the recorded `@-` base. It may snapshot normal JJ working-copy state but does not move, rewrite, discard, or edit source files. Integration runs `workspace update-stale` in both workspaces, rejects recovery output, resolves the recorded source/base/root Change IDs uniquely, verifies that source `@` still has the recorded base as its sole parent, verifies the delegated root’s direct base and complete workspace ancestry, rejects foreign descendants, and runs:

```text
jj rebase -s 'exactly(change_id(<root-change-id>), 1)' -B '<source-workspace>@'
```

This inserts the complete rooted subtree before source `@` without assuming how many changes the planner created. JJ rebases the same source working-copy change over the delegated tip, yielding `recorded base -> delegated subtree -> original source @` while retaining its working-copy diff on disk. Integration verifies that the source workspace still targets the same Change ID, that the delegated tip is now its direct parent, and that no conflicts or unexpected descendants appeared. Cleanup is a separate operation after verified integration.

Any unexpected graph, divergent Change ID, stale recovery, conflict, partial integration, or cleanup error enters `attention_required`. Thinker must preserve the operation log, workspace, files, and record; report the exact failure; and stop all JJ mutation. It must never attempt its own undo, abandon, conflict resolution, second rebase, or history repair.

## Parent controls

- `subagent`: launch one allowed child from a structured packet;
- `message_child`: send steering or follow-up instructions;
- `child_status`: inspect direct children without consuming completion;
- `wait_for_children`: wait for `next` (default) or `all` selected children;
- `respond_to_child`: answer the current correlated question;
- `abandon_child`: terminate the process without filesystem cleanup;
- `planner_workspace`: create a JJ-preferred isolated workspace and launch exactly one planner;
- `integrate_planner_workspace`: integrate a completed planner workspace and stop on any uncertainty;
- `cleanup_planner_workspace`: forget and remove only a cleanly integrated planner workspace.

`message_child` delivery is intentional: `steer` reaches the active run, while `followUp` queues a subsequent instruction. For `Give me a status report, then continue.`, use `steer`. Packaged planners and workers emit a bounded visible interim status, do not call `report_to_parent` for it, and resume the original objective without another prompt. Their later terminal report still occurs exactly once and only after their descendants resolve. The JSONL child log and activity UI expose the interim assistant text without inventing a terminal protocol state.

`wait_for_children` uses a 1.5-second initial discovery grace when no matching child is visible. This covers Pi's parallel tool execution race where `subagent` and `wait_for_children` begin as sibling tool calls and waiting reaches durable storage just before spawning does.

`wait_for_children` returns early for a child requiring parent attention. `next` marks one terminal result collected, so repeated calls yield later completions. `all` waits for all selected children unless a question requires a response.

Every delegated child receives `report_to_parent`. A worker cannot report while its own direct children remain unresolved. Reporting persists exactly one completed, blocked, failed, or cancelled outcome and requests graceful child shutdown.

## Activity UI

While root subagents are enabled in TUI mode, Pi-Tai pins a two-line card for every unresolved or uncollected direct child below the editor:

```text
subagent · worker · Implement the bounded task
  running · Reading the affected tests now
```

The second line is derived only from visible assistant text in the child's RPC stream; hidden thinking is never displayed. Awaiting questions and terminal report summaries replace the live line when appropriate. Collected terminal results disappear from the widget.

Run `/subagents list` to select a direct child and open a detailed overlay containing its task packet, model and effort, status, latest visible activity, report, runtime identity, session file, and log path. `/subagents list <delegation-id>` opens one child directly.

## Persistence and migration

Records live under:

```text
~/.pi/agent/pi-tai/subagents/
├── delegations/
├── sessions/
├── logs/
├── control/
└── prompts/
```

Version-3 records store cwd, structured packet, role snapshot, process/session metadata, lifecycle, questions, responses, messages, collection state, and the optional discriminated planner-workspace lifecycle. Updates use per-record locks and atomic replacement.

Version-1 and version-2 workspace records migrate losslessly. Their old workspace attachment is retained as `legacyWorkspace` recovery metadata and its path becomes the inherited cwd. New code never integrates, finalizes, removes, or otherwise mutates that workspace automatically.

## Model profiles

Agent definitions and interactive model profiles are independent. Definitions configure child identity and authority. Profiles only switch the current session's model and effort.

Configure ordered profiles in global or trusted-project `pi-tai.json`:

```json
{
  "modelProfiles": [
    { "name": "sol-high", "provider": "openai-codex", "model": "gpt-5.6-sol", "effort": "high" },
    { "name": "sol-low", "provider": "openai-codex", "model": "gpt-5.6-sol", "effort": "low" },
    { "name": "luna-high", "provider": "openai-codex", "model": "gpt-5.6-luna", "effort": "high" }
  ]
}
```

A configured array replaces the lower-scope/default array and preserves cycle order. Shift+Tab cycles it, while Ctrl+Alt+T runs Pi's native thinking-level cycle; `/profile [name]` selects a profile; `/effort [level]` changes effort independently. Model selection must succeed before a profile changes effort. The footer shows the actual model ID and applied effort, for example `gpt-5.6-sol · high`. While subagents are enabled it shows `thinker` beside the directory; workspace backends are not capability labels.
