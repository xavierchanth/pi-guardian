# In-process child runtime and messaging model

## Decision

A child is a managed **Pi SDK `AgentSession` context inside the root Pi process**, not a spawned `pi` process and not a user-selectable Pi session.

Each child still needs an isolated model context, tools, model, effort, cwd, compaction state, and durable recovery journal. Those are implementation details owned by the concurrency coordinator. The user remains in one root session and cannot enter or resume a child through Pi's normal session selector.

This model is supported by Pi's SDK:

- multiple `AgentSession` objects can exist in one process;
- each session has independent messages, tools, model, effort, cwd, and event subscriptions;
- `SessionManager` can be in-memory or use a caller-selected persistent directory;
- inline extensions can expose a bridge inside each child;
- `pi.sendMessage()` injects a custom, non-user message and can deliver it as `steer`, `followUp`, or `nextTurn`;
- `triggerTurn: true` starts the recipient when idle;
- custom entries persist coordinator state without entering model context; and
- tool-result `usage` contributes nested model work to Pi's session totals.

The current subprocess/FIFO architecture is therefore an implementation choice, not a required Pi boundary.

## Runtime topology

```text
root Pi process
└── ConcurrencyCoordinator
    ├── root AgentSession (user-visible)
    ├── child context: planner A
    ├── child context: worker B
    ├── child context: reviewer C
    ├── event inbox
    ├── file-mutation queues
    ├── JJ mutation mutex
    └── durable lifecycle / usage journal
```

A child context is identified by a concurrency-owned context ID and linked to:

- root Pi session ID;
- direct parent context ID, or root;
- delegation and execution-cycle IDs;
- role snapshot and task packet;
- cwd or isolated workspace attachment;
- managed context journal;
- current lifecycle and resume point; and
- cumulative usage ledger.

The coordinator may use Pi `SessionManager` internally, but child journals live in a private Pi-Tai state directory rather than the normal project session directory. They are not listed by `/resume`, `/fork`, `/tree`, or other user session navigation.

## Child-to-parent events

Children push typed events to their direct parent. A parent never polls or reads a child transcript to discover completion.

```ts
type ChildEvent =
  | { kind: "question"; questionId: string; summary: string; options?: string[] }
  | { kind: "completed"; report: BoundedChildReport }
  | { kind: "blocked" | "failed"; report: BoundedChildReport }
  | { kind: "status"; requestId: string; report: BoundedStatusReport }
  | { kind: "lifecycle"; phase: "stalled" | "resumed" | "cancelled"; summary: string };
```

The coordinator injects the event into the parent as a custom message such as `pi-tai-child-event`, never as a user message. The visible TUI renderer identifies the child role and ID.

Delivery policy:

- a question or terminal report uses `steer` delivery;
- if the parent is idle, `triggerTurn: true` starts it immediately;
- if the parent is streaming, delivery occurs at Pi's safe steering boundary after the current assistant turn's tool calls;
- routine progress is persisted but not injected;
- status is injected only in response to a request; and
- simultaneous events are coalesced into one bounded envelope when possible.

This lets a child finish while the parent is working and be steered into the parent's next model turn without impersonating the user.

## Parent-to-child messages

The parent has one conceptual operation:

```text
message child-id: payload
```

Typed wrappers may provide question responses, status requests, cancellation, or review feedback, but all use the same coordinator channel and become custom `pi-tai-parent-message` messages in the child context.

Delivery uses the child's inline SDK bridge:

- `steer` for a new priority or status request;
- `followUp` for work that should happen after the current run;
- `triggerTurn: true` when idle.

If the child is suspended in an await operation, only that await is cancelled before delivery. Descendant contexts continue.

## Push and await are complementary

Push events replace polling, but they do not remove the need for an await primitive.

`await_child_event` is a token-free suspension/barrier used when a parent has no independent work. It wakes on one child question or terminal event. The same event would have been delivered by push if the parent were active.

Therefore:

- active parent: child event is steered in automatically;
- idle orchestrating parent: await sleeps without model calls and wakes on the event;
- user message while awaiting: the input hook immediately resolves/cancels only the active await before Pi's normal steering path, so the message is not trapped behind a wait that depends on a child;
- final completion: a deterministic gate still requires every direct child to be terminal and acknowledged.

“Acknowledged” replaces transcript collection. The parent acknowledges the bounded child-authored report and usage receipt; it never imports the child's conversation history.

## Context boundary

The separation is strict:

### Parent may receive

- child ID, role, objective, and lifecycle;
- bounded child-authored question, status, terminal report, or reviewer findings;
- exact changed paths and JJ Change-ID boundaries when relevant;
- validation results, concerns, and recovery state;
- aggregate and per-model usage totals.

### Parent must not receive

- child transcript;
- child hidden reasoning;
- raw tool stream;
- complete child logs;
- unbounded diffs, command output, or file contents;
- repeated progress narration.

Rich details remain in non-context coordinator state for UI diagnostics. A parent model can request a fresh bounded summary with an explicit focus and question list, but there is no model-facing “read child history” operation.

Suggested caps:

- status summary: 400 tokens;
- question: 250 tokens plus bounded options;
- terminal report: 1,200 tokens;
- coalesced parent event envelope: 2,000 tokens;
- reviewer report: 1,500 tokens plus structured findings kept in non-context details.

If a report exceeds its cap, the child must summarize it rather than truncating arbitrary history.

## Status

A metadata status query is local and does not wake the child. It returns only:

- lifecycle phase;
- last event time;
- current objective;
- current wait/resume point;
- workspace/review phase;
- held or queued file names; and
- whether a fresh summary is available.

A fresh semantic status request sends a correlated message to the child. The child returns a bounded summary, then resumes its saved activity. `request_child_summary` supports a narrower focus and explicit questions when the standard status is insufficient. Neither operation reads the child's journal or transcript from the parent.

## Restart, crash, hang, and `/continue`

### Process restart

When the root Pi process restarts, all in-memory child `AgentSession` objects are gone. On root `session_start` or `/continue`, the coordinator:

1. loads durable child-context records linked to the root session;
2. reconciles workspace heads, tracked Change IDs, and persisted JJ operation receipts;
3. marks prior file/workspace lock claims interrupted and starts with empty in-memory lock queues;
4. recreates every child that was `running`, `starting`, or safely `suspended`;
5. restores each managed context journal, model, tools, cwd, compaction state, and resume point;
6. sends a custom continuation message to each recreated child, which must reacquire its file set or workspace write token before writing; and
7. injects one bounded aggregate lifecycle event into the root.

Terminal, cancelled, `attention_required`, and parent-question states are not blindly restarted. An unanswered question is re-presented to the parent. An acknowledged terminal child remains terminal.

### Child crash

An SDK run error does not destroy the child context. The coordinator records the failed execution cycle and may start a replacement cycle in the same child context if:

- no mutation is still in flight;
- workspace/file ownership is intact;
- retry policy permits it; and
- the durable journal can be restored.

The replacement receives a recovery message and the prior bounded task state. A retry is linked to the failed cycle rather than erasing it.

### Suspected hang

No-output time alone does not prove a hang. A child becomes `stalled` after a role/tool-specific heartbeat deadline. The coordinator first requests status. If there is still no response:

1. request SDK abort;
2. wait for the current tool mutation queue to settle;
3. dispose the old `AgentSession` only after it is quiescent; and
4. recreate it from the durable journal.

Never run an old and replacement writer concurrently. If quiescence cannot be proved, preserve ownership and ask the user rather than duplicating the child.

### Interrupted tool calls

Restart does not blindly replay every interrupted tool call.

- Read-only inspection, status, and await operations may be reissued.
- An interrupted file edit is retried only after reacquiring locks and re-reading current content.
- An interrupted `checkpoint_change`, `workspace_checkpoint`, `rebase_workspace`, squash, or integration first reconciles its idempotency key, tracked Change IDs, current graph, and operation receipt.
- If the postcondition already holds, synthesize the missing result and continue.
- If no mutation boundary was crossed, reissue safely.
- If completed boundaries cannot be proved, stop affected mutation and request recovery direction.

The persistent record stores intent and receipts, not live lock ownership. Locks and queue positions are always ephemeral and reset after process restart.

### Child compaction

Every child SDK context uses Pi-Tai's automatic compaction policy independently, including the configured default threshold (currently 90%). Compaction summaries and their usage remain in the private child journal. Restart restores the compacted context rather than expanding child history into the root.

### `/continue`

`/continue` is a visible prompt template like `/parallelize`. Its first action is `reconcile_children`; it then resumes the root task and uses `await_child_event` only when no independent work remains. Reconciliation is recursive for delegating children. It does not relaunch terminal work or bypass workspace incidents.

## Usage and cost accounting

The coordinator keeps one root-scoped usage ledger while preserving attribution:

```ts
interface ConcurrencyUsageLedger {
  total: Usage;
  byModel: Record<`${string}/${string}`, Usage>;
  byRole: Record<string, Usage>;
  byContext: Record<string, Usage>;
  byExecutionCycle: Record<string, Usage>;
}
```

Every child assistant message contributes intrinsic usage exactly once. Nested descendant usage is not copied into ancestor intrinsic totals. The root ledger derives rollups from immutable per-message/per-cycle entries.

Pi currently includes assistant-message usage directly and nested tool-result `usage` in native session totals, but nested tool usage is grouped as `Tools/summaries`, not by the child model. The target integration should therefore:

1. preserve the detailed concurrency ledger as the source of model/role/context attribution;
2. expose one combined total in the root UI and session inspection;
3. attach child usage to exactly one parent acknowledgement/tool receipt when possible so native Pi totals remain accurate; and
4. avoid adding the same usage through both child completion and later acknowledgement.

If Pi gains an attributable custom-message usage API, child event delivery can carry the receipt directly. Until then, detailed per-model child attribution remains a Pi-Tai ledger layered beside Pi's native total.

## Pi SDK implications

- Use `createAgentSession()` directly for children; do not spawn `pi --mode rpc`.
- Give each child a custom `ResourceLoader`, exact tools, and an inline parent-message bridge.
- Keep root and child event subscriptions separate.
- Use custom messages for parent/child protocol and custom entries for non-context lifecycle persistence.
- Rebind/recreate child sessions explicitly after root session replacement or reload.
- Reuse Pi's exported `withFileMutationQueue()` for shared-source same-file serialization, extending the critical section through `checkpoint_change`; isolated workspaces instead serialize writers behind one workspace-wide token and `workspace_checkpoint`.
- Do not use Pi's user-facing session tree as the child hierarchy; its branches are conversation alternatives, not concurrently runnable contexts.
