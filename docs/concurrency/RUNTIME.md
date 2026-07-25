# Child runtime and messaging

## Decision

A child is a managed private Pi SDK `AgentSession` context, not a spawned `pi` process and not a user-selectable Pi session.

Each child has independent messages, tools, model, effort, cwd, compaction, journal, lifecycle, and usage. The user remains attached to one root session. Private children do not appear in normal resume, fork, or tree navigation.

## Topology

```text
Host-owned root session
└── root runtime worker / Pi SDK context
    └── root-scoped ConcurrencyCoordinator
        ├── child context: planner
        │   ├── worker
        │   └── scout
        ├── child context: researcher
        ├── event inbox and wait registry
        ├── file-set queues
        ├── workspace writer tokens
        ├── JJ mutation mutex
        └── durable event/usage/receipt adapters
```

Separate roots never share child trees, events, waits, lock ownership, or attribution.

## Child identity

A durable child record binds:

- Host/root session ID;
- child and direct-parent context IDs;
- delegation and execution-cycle IDs;
- immutable role and agent-definition snapshot;
- self-contained task packet;
- source cwd or managed workspace attachment;
- private journal reference;
- lifecycle, resume point, and reconciliation state;
- event acknowledgement and usage entries.

A child context represents durable delegated intent. A linked execution cycle represents one concrete attempt or recovery run.

## Child-to-parent events

```ts
type ChildEvent =
  | { kind: "question"; eventId: string; questionId: string; summary: string; options?: string[] }
  | { kind: "status"; eventId: string; requestId: string; report: BoundedStatusReport }
  | { kind: "terminal"; eventId: string; outcome: "completed" | "blocked" | "failed"; report: BoundedChildReport }
  | { kind: "incident"; eventId: string; reason: string; recovery: string }
  | { kind: "human_execution_required"; eventId: string; action: ProposedAction; reason: string }
  | { kind: "lifecycle"; eventId: string; phase: "stalled" | "resumed" | "cancelled"; summary: string };
```

Policy:

- persist before delivery;
- question/terminal/incident events steer an active parent or trigger an idle one;
- human-execution requirements bypass intermediate agents and route directly to the root session; no parent response can authorize execution;
- routine progress stays outside parent model context;
- status is correlated to a request;
- status events may coalesce under explicit supersession;
- question and terminal identities never merge;
- at most one unresolved blocking question exists per execution cycle.

## Parent-to-child messages

One semantic channel carries:

- instruction or steering;
- correlated question response;
- status/summary request;
- review feedback;
- quiet continuation after recovery;
- explicit cancellation intent.

Messages are custom protocol messages, not user-role messages. If a child is suspended awaiting descendants, only the stale await is cancelled before delivery; descendants continue.

## Event lifecycle

```text
created → persisted → delivered → acknowledged
```

Delivery means the same semantic event ID was durably appended to the parent context. Failure retries that ID. Acknowledgement proves the parent consumed the bounded report and imports usage attribution once. It never imports child history.

## Push and await

Push is the delivery mechanism. Await is an optimization:

- active parent: pushed event arrives at Pi's safe steer boundary;
- idle parent with no independent work: `await_child_event` suspends token-free;
- user input during await: resolve only the wait, preserve input, leave children running;
- final settlement: deterministic direct-child terminal-and-acknowledged gate.

Repeated model polling is forbidden.

## Context boundary

Parent model may receive:

- child ID, role, objective, phase;
- bounded question/status/terminal report;
- changed paths and stable JJ boundaries;
- validation, findings, concerns, and recovery state;
- aggregate usage.

Parent model never receives:

- child transcript or hidden reasoning;
- raw tool stream or complete logs;
- unbounded diffs/output/files;
- repeated progress narration.

Recommended maxima: 250 tokens for questions, 400 for status, 1,200 for terminal results, 1,500 for reviewer reports, and 2,000 for a coalesced event envelope. Oversized detail becomes a managed artifact.

## Status

Host concurrency projections report bounded lifecycle, objective, question, claim, workspace/review, receipt, incident, and usage summaries without waking the child.

`request_child_status` sends a bounded correlated request with optional focus and additional questions. The child answers from its own context and resumes prior work. Parent-side history summarization is unavailable.

## Cancellation

- Aborting/steering the root turn does not cancel children.
- Explicit child cancellation ends the selected execution cycle.
- Recursive cancellation is separate and post-order.
- Cancellation preserves reports, journals needed for recovery, descendants unless selected, and workspace custody.
- A cancelled cycle does not auto-resume; an intentional retry creates a linked cycle.

## Restart and continuation

On Host/worker/root restart:

1. load durable child records for the root;
2. clear runtime waits, subscriptions, queues, and lock ownership;
3. mark prior claims interrupted;
4. reconcile JJ/workspace receipts before writable recovery;
5. traverse deepest descendants before parents;
6. recreate only safe quiescent running/starting/suspended contexts;
7. persist each descendant disposition;
8. send recreated parents quiet bounded continuation messages;
9. emit one aggregate root recovery event.

Terminal, cancelled, attention-required, and mutation-stopped contexts are not relaunched. An unanswered question is re-presented, not duplicated.

A replacement writer never starts until the old SDK/process/tool writer is proved quiescent.

## Compaction and journals

Each child applies Pi-Tai compaction independently. Compaction summaries remain in private journals and never expand into root context.

Raw journals are deleted only after clean objective closure proves:

- no active/recoverable cycle;
- terminal events acknowledged;
- usage snapshotted;
- workspace custody closed or independently retained;
- bounded reports and receipts durable.

Blocked, incidented, or unresolved work retains journals.

## Usage

The authoritative side ledger stores intrinsic entries once by provider/model, role, context, execution cycle, and message. Ancestors do not copy descendant usage into intrinsic totals. Delivery and acknowledgement add no usage.

Native Pi totals may remain informational if they cannot preserve child attribution. The Host/core ledger supplies exact rollups and warnings for missing telemetry.
