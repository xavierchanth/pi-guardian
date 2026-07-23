# Pi-Tai declarative subagents

Pi-Tai provides opt-in nested delegation through persistent isolated Pi processes. Subagents share the caller's working directory but never inherit its conversation. Automatic JJ workspace and Git worktree allocation is not part of subagent execution.

## Activation

```text
/cap:subagents on
/cap:subagents status
/cap:subagents off
```

Subagents are disabled by default. `on` resolves the effective root definition, validates its model and tools, snapshots the current model/effort/tools, and applies the root definition to the main session. `off` is rejected while direct children are unresolved and otherwise restores that snapshot. No workspace capability is probed or leased.

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
├── worker
├── scout
└── researcher

worker
├── scout
└── researcher
```

`thinker` uses Sol high, `worker` uses Sol low, `scout` uses Luna medium, and `researcher` uses Terra medium. Researcher intentionally has no web tools until those tools are implemented and explicitly added.

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
- only the Pi-Tai child runtime, work-context tool, and Guardian;
- a private persistent session, FIFO control channel, and JSONL log;
- the direct parent's cwd;
- no skills, unrelated extensions, or conversation history.

The role snapshot includes source path and content hash, so edits affect future launches without silently widening a running child's authority. Nested workers receive only their own allowed descendant names and must compile fresh sparse packets.

Because cwd is shared, the packaged worker prompt requires reading and re-reading before writes, narrow edits, preservation of unrelated changes, and validation after mutation. Pi-Tai does not currently serialize writer children; callers remain responsible for sensible task partitioning.

## Parent controls

- `subagent`: launch one allowed child from a structured packet;
- `message_child`: send steering or follow-up instructions;
- `child_status`: inspect direct children without consuming completion;
- `wait_for_children`: wait for `next` (default) or `all` selected children;
- `respond_to_child`: answer the current correlated question;
- `abandon_child`: terminate the process without filesystem cleanup.

`wait_for_children` returns early for a child requiring parent attention. `next` marks one terminal result collected, so repeated calls yield later completions. `all` waits for all selected children unless a question requires a response.

Every delegated child receives `report_to_parent`. A worker cannot report while its own direct children remain unresolved. Reporting persists exactly one completed, blocked, failed, or cancelled outcome and requests graceful child shutdown.

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

Version-3 records store cwd, structured packet, role snapshot, process/session metadata, lifecycle, questions, responses, messages, and collection state. Updates use per-record locks and atomic replacement.

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

A configured array replaces the lower-scope/default array and preserves cycle order. Shift+Tab cycles it; `/profile [name]` selects a profile; `/effort [level]` changes effort independently. Model selection must succeed before a profile changes effort. The footer shows effective role, actual model ID, and applied effort, for example `Thinker · gpt-5.6-sol · high`.
