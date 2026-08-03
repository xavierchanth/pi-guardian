# Machine Host

## Purpose

The Host binds Pi-Tai to one machine. It is long-lived independently of terminal, desktop, and editor clients and is authoritative for sessions that need persistence, background execution, or multi-client access.

The Host may initially ship as a tray application rather than an operating-system daemon. The packaging choice does not weaken its authority boundary.

## Responsibilities

### Machine identity and trust

- generate and retain a stable Host installation ID;
- protect a machine private key or platform credential;
- authenticate and enroll local clients;
- pair remote clients explicitly;
- attribute commands to client and session identity;
- advertise available machine capabilities;
- expose no public listener by default.

Machine binding means resources and execution have a known home. It does not mean data can never be exported.

### Session authority

- assign stable product session IDs;
- serialize commands per session;
- enforce operation idempotency and expected revisions;
- own foreground state, client attachments, and runtime health as independent facts;
- persist canonical events, snapshots, artifacts, and usage;
- retain sessions while all clients are disconnected;
- recover durable history after restart;
- distinguish interruption from successful continuation.

### Runtime supervision

- package and start the Pi SDK runtime worker;
- bind a worker generation to a session activation;
- detect termination or stall;
- prove an old writer quiescent before replacement;
- reconcile interrupted tools and child contexts;
- unload eligible idle sessions and reload on demand;
- preserve incidents rather than guessing rollback.

### Capability enforcement

- keep credentials and ambient machine access out of clients;
- resolve capability requests against installed adapters;
- apply Guardian decisions before side effects;
- retain bounded audit and evidence records;
- scope capability availability per Host and session.

## Session actor

One serialized actor or equivalent command queue owns each session. Its state includes:

```text
Session
├── stable identity and metadata
├── revision and ordered event cursor
├── client attachments
├── foreground state
├── runtime health and generation
├── root context and child topology
├── workspace/resource custody
├── interactions requiring action
├── command idempotency records
├── usage ledger
└── artifact references
```

Foreground state and runtime health are orthogonal:

```ts
type ForegroundState =
  | { phase: "idle"; lastStopReason?: string }
  | { phase: "running"; operationId: string }
  | { phase: "requires_action"; operationId: string; interactionId: string };

type RuntimeHealth =
  | { phase: "unloaded" }
  | { phase: "starting"; generation: number }
  | { phase: "ready"; generation: number }
  | { phase: "interrupted"; generation: number; reason: string }
  | { phase: "failed"; reason: string };
```

Invalid combinations are rejected: unloaded/failed runtime cannot commit with running foreground work; `requires_action` must reference the current operation; idle holds no current interaction.

## Client arbitration

Initially, every authenticated and authorized client may observe and submit supported commands.

- A valid accepted mutation becomes the current active-client attribution.
- Commands carry operation IDs for idempotency.
- State-changing commands carry expected revision or equivalent precondition.
- Two commands based on one revision do not both win.
- Cancellation and answers target stable durable IDs.
- A second prompt is rejected while foreground work is non-idle unless an explicit queueing feature is later designed.
- Process disconnect removes an attachment; explicit close may cancel/release activation according to the client contract.

## Host lifecycle

- Closing a desktop window does not stop the Host.
- Closing an ACP shim or terminal detaches that client.
- Host shutdown warns when foreground operations are active.
- Complete Host crash may interrupt active tools; recovery reports this honestly.
- A successful command acknowledgement means the command/event transition is durable, not that an OS-level side effect is transactionally reversible.

## Rust and TypeScript boundary

The existing direction is appropriate:

- Rust owns portable Host lifecycle, IPC, persistence, process supervision, and native application concerns.
- TypeScript owns Pi SDK integration and the shared behavioral core.
- Typed protocols isolate process churn.
- Generated wire bindings do not become canonical domain models.

Avoid duplicating session policy in Rust and TypeScript. Rust validates Host-level invariants; the core validates agent/session-runtime invariants.
