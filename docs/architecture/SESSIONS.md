# Sessions and persistence

## Decision

> The Host is the sole authority for durable Pi-Tai session state.

The core defines session semantics and persistence ports. Host adapters implement them. Clients receive projections. Pi SDK journal files are runtime recovery material, not an independent product authority.

## Canonical data

The Host durably owns:

- session ID, name, workspace identity, ownership, and timestamps;
- accepted commands and operation-id deduplication;
- ordered user, assistant, tool, interaction, plan, lifecycle, and usage events;
- current revision and event cursor;
- foreground operation and runtime health;
- model/provider/effort configuration required for continuation;
- work context and task-plan snapshots;
- child contexts, execution cycles, questions, event acknowledgement, and recovery dispositions;
- workspace custody, stable JJ Change IDs, operation and review receipts;
- artifacts and retention metadata;
- client attachments and active-client attribution.

Raw ACP payloads, Pi logs, and subprocess output may be retained as redacted diagnostics. They are not canonical product state.

## Persistence model

A practical single-machine implementation uses SQLite in WAL mode plus managed artifact and private-journal directories.

```text
Host storage
├── append-only normalized session events
├── idempotent command records
├── validated snapshots/projections
├── usage and operation receipts
├── artifact metadata
└── managed files
    ├── private Pi context journals
    ├── bounded large review/diff artifacts
    └── retained incident evidence
```

Domain contracts must not expose SQLite row shape. Snapshots are caches over validated events and can be rebuilt. Corrupt or ambiguous snapshots are quarantined rather than admitted as valid state.

## Event requirements

Every event has:

- stable event ID;
- session ID;
- monotonic session sequence/cursor;
- semantic item or operation ID where applicable;
- causating command/client identity;
- event kind and version;
- durable timestamp;
- bounded payload or artifact reference.

Events describe semantic facts rather than protocol patches. Protocol adapters convert between canonical events and ACP/client-specific omitted, clear, replace, and append semantics.

## Command acceptance

```text
receive command
→ authenticate client
→ validate expected revision and semantic preconditions
→ deduplicate operation ID
→ allocate durable semantic IDs
→ transactionally persist accepted command and immediate state events
→ acknowledge acceptance
→ execute runtime work
→ persist subsequent events in order
```

Acknowledgement does not imply foreground completion. Prompt acceptance and operation settlement are different transitions.

## Replay

A reconnect supplies a cursor. For replay from the beginning or an older cursor:

1. attach the client and choose a replay high-water mark;
2. buffer later live events;
3. emit canonical projections through the mark in sequence order;
4. complete the attach/resume response;
5. release buffered later events without duplication;
6. continue live delivery.

Replay favors complete current item snapshots where a wire protocol permits them. Chunk boundaries are not product identity.

## Client-local state

Clients may retain only discardable presentation state:

- viewport and panel state;
- keybindings and theme;
- unsent editor drafts;
- cached projections;
- last observed event cursor;
- reconnect credentials.

A client cache must be rebuildable from Host state. No client owns the sole copy of an accepted command or lifecycle transition.

## Pi journals

Private Pi journals support model-context continuation, compaction, and child recovery. Rules:

- Host/core records map each journal to a product session/context and runtime generation.
- Normal client session navigation never lists private child journals.
- Reopening a journal cannot bypass Host lifecycle reconciliation.
- Raw journals remain while a context is resumable, blocked, incidented, or owns unresolved workspace custody.
- Clean objective closure deletes raw journals only after bounded reports, events, receipts, and usage are durable.
- Product replay does not require exposing raw journal history.

## Recovery

### Client failure

Detach only. Runtime work continues unless an explicit cancel/close command is durably accepted.

### Worker failure

- mark runtime generation interrupted;
- settle or mark the foreground operation honestly;
- prove old process/tool writers quiescent;
- classify interrupted operations from receipts;
- recreate only safe resumable contexts;
- preserve unknown mutations as incidents.

### Host failure

On restart:

- validate/rebuild projections from canonical events;
- detect interrupted runtime generations;
- restore client-independent session state;
- reconcile child trees and JJ operations before mutation;
- expose historical sessions even when an interrupted turn is not resumable.

## Retention

Retain compact canonical events, receipts, bounded reports, and usage required for audit and continuation. Treat large diffs, tool output, and raw journals as managed artifacts with explicit retention. Cleanup validates canonical containment and symlinks and never follows user-provided arbitrary paths.

## Multi-machine constraints

Remote attachment does not replicate authority. Every session has one home Host. Moving a session later requires explicit transfer of:

- writer lease/fencing token;
- complete event and snapshot state;
- Pi context material;
- artifacts;
- repository/workspace availability;
- machine capability requirements;
- credential limitations;
- in-flight-operation quiescence.

A session whose filesystem, credentials, or browser state cannot move remains on its original Host.
