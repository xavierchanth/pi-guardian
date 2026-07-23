# Pi-Tai declarative subagents

Pi-Tai provides opt-in nested delegation through persistent isolated Pi processes. Normal subagents share the caller's working directory; thinker may instead launch exactly one planner in a recorded isolated workspace. No child inherits its parent's conversation.

## Activation

```text
/subagents
/subagents on
/subagents list
/subagents inspect [delegation-id]
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

`thinker` and `planner` use Sol high, `worker` uses Sol low, `scout` uses Luna medium, and `researcher` uses Terra medium. Thinker may delegate to a planner, worker, scout, or researcher. Planner may delegate to a worker, scout, or researcher. Worker may delegate only to scouts or researchers. Only the single root thinker owns workspace tools; it may launch a planner or worker in a workspace, while no child can create a workspace. The validated child graph contains no self-edges or cycles, so delegation depth is structurally bounded. Thinker, planner, and researcher explicitly receive `web_search` and `web_fetch`; worker and scout do not. Standalone sessions retain both as normal Pi-Tai tools.

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
- the direct parent's cwd for normal subagents, or a recorded isolated JJ workspace for `workspace_subagent`;
- no skills, unrelated extensions, or conversation history.

The role snapshot includes source path and content hash, so edits affect future launches without silently widening a running child's authority. Nested workers receive only their own allowed descendant names and must compile fresh sparse packets.

Because cwd is shared for normal delegation, the packaged planner and worker prompts require narrow assignments, reading and re-reading before writes, preservation of unrelated changes, and validation after mutation. Parent and child processes may work concurrently; Pi-Tai does not pause the parent or serialize writers, so callers remain responsible for sensible task partitioning and avoiding duplicate work.

Delegation is not completion. The packaged thinker, planner, and worker prompts require each parent to track every direct child, repeatedly use the wait-any `wait_for_children` tool after useful independent work, handle questions, and consume every terminal result. A delegating root cannot present the delegated work as complete, and a delegating child cannot call `report_to_parent` or end its run, while any owned direct child is unresolved or its terminal result is uncollected. Delegation announcements and `child_status` inspection do not collect results.

## Workspace policy

Pi-Tai supports JJ workspaces only. Change IDs are durable identities, and only the single root thinker can create or integrate delegated workspaces. `workspace_subagent` accepts `planner` for decomposed work or `worker` for bounded implementation; the thinker may launch as many independent slices as useful. Children cannot create workspaces recursively.

Creation branches the delegated root from source `@-`, so source `@` may contain active work. Integration also permits a dirty source `@`: its Change ID and file content are preserved, while inserting work before it rewrites its parent and commit ID and can make its checkout stale.

Deterministic integration:

1. updates stale in delegated and source workspaces;
2. validates the recorded base, root, head, and complete ancestry;
3. captures all relevant Change IDs;
4. forgets the delegated workspace and removes its directory;
5. abandons every empty delegated revision;
6. rebases the remaining revision set before the recorded source Change ID with `--ignore-working-copy`;
7. verifies ancestry and conflicts; and
8. returns retained and undescribed Change IDs.

An entirely empty range succeeds as cleanup-only integration. The thinker then inspects and describes every retained undescribed revision before reporting completion. Unexpected graphs, stale recovery, conflicts, or partial operations enter `attention_required`; the thinker reports whether the workspace was already removed and stops further JJ mutation.

## Parent controls

- `subagent`: launch one allowed child from a structured packet;
- `message_child`: send steering or follow-up instructions; a steer aimed at a child currently blocked in `wait_for_children` first cancels that stale wait and then hard-submits the parent message as a new prompt;
- `child_status`: inspect direct children without consuming completion;
- `collect_status`: request non-terminal reports from every unresolved descendant, wait up to 30 seconds total, and return a complete or partial tree;
- `wait_for_children`: wait for the next selected direct-child completion or question;
- `respond_to_child`: answer the current correlated question;
- `abandon_child`: terminate the process without filesystem cleanup;
- `workspace_subagent`: root-only creation of an isolated JJ workspace running a planner or worker;
- `integrate_workspace`: update stale, validate, forget/remove, strip empties, and integrate a completed workspace child;
- `describe_integrated_changes`: apply thinker-chosen descriptions to retained integrated Change IDs and verify them;
- `report_status`: child-only non-terminal response to a correlated status request.

`wait_for_children` uses a 1.5-second initial discovery grace when no matching child is visible. This covers Pi's parallel tool execution race where `subagent` and `wait_for_children` begin as sibling tool calls and waiting reaches durable storage just before spawning does.

`wait_for_children` is wait-any: it always returns after one selected child completes or requires parent attention, not after all selected children resolve. The parent must handle a returned question and resume waiting, calling the tool repeatedly until every owned direct child is resolved and every terminal result has been collected. A terminal result is collected once, so repeated calls yield later completions. Its bounded deterministic progress details contain IDs, parent links, and phases rather than complete durable records.

Every delegated child receives `report_to_parent`. The runtime rejects a report while direct children remain unresolved; the packaged prompt and model-facing tool guidance additionally require consuming all of their terminal results first. Reporting persists exactly one completed, blocked, failed, or cancelled outcome and requests graceful child shutdown. As a reliability fallback, `agent_settled` completes a still-running child from its final visible assistant text only after every direct descendant is resolved. Explicit reports and correlated parent questions always win.

On first collection, `wait_for_children` attributes the direct child's complete descendant-tree usage to the parent tool result. Accounting sums only intrinsic assistant-message usage for every tree node, avoiding both repeated-wait attribution and nested tool-result double counting.

## Activity UI

Pi-Tai does not pin persistent child cards below the editor. `/subagents list` opens a full-width inline Active/Inactive tabbed pane containing direct children and every descendant. Active contains only unresolved or awaiting work; terminal descendants move to Inactive, which retains historical completed, blocked, failed, cancelled, and abandoned records. Rows form a filesystem-style tree from durable parent delegation IDs, using `├──`, `└──`, and `│   ` connectors with last siblings calculated within the current tab. The inspect selector uses the same tree projection, so workers, scouts, and researchers remain visibly owned by their planner or worker rather than being inferred from row order. The content viewport is capped at 16 rows so its top and controls remain reachable. Each delegation occupies one row; long task objectives are truncated with an ellipsis after accounting for the tree prefix rather than wrapped. Left and Right switch tabs; Up and Down scroll; Page Up and Page Down move by a viewport; Home or `g` jumps to the top; End or `G` jumps to the bottom; Escape closes it.

`/subagents inspect [delegation-id]` owns selection and detail inspection. Its full-width inline Inspect pane uses the same capped, keyboard-scrollable viewport and supports the same `g`/`G` top/bottom jumps. It includes the task packet, model and effort, lifecycle, latest visible activity, complete descendant-tree usage, report, runtime identity, and deterministic visible user/assistant/tool transcript projection. Hidden reasoning is never displayed. Enter selects; Escape cancels the selector without inspecting its highlighted row, or closes the inspect pane.

While `wait_for_children` is active, its compact progress view renders only unresolved selected direct children and unresolved descendants with the same filesystem-style connectors. Last-sibling connectors are recalculated for this live projection. Terminal descendants are omitted from it but remain available in Inactive and explicit inspect. The view rereads durable lifecycle data without asking a model to summarize activity.

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

Version-3 records store cwd, structured packet, role snapshot, process/session metadata, lifecycle, questions, responses, status reports, messages, collection state, and the optional discriminated JJ workspace lifecycle. Updates use per-record locks and atomic replacement.

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
