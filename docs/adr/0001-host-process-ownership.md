# ADR 0001: Host Agent owns durable sessions

- Status: Accepted
- Date: 2026-01-15

## Context

Zed, a future desktop manager, mobile, and diagnostic tools must attach and detach without changing the lifetime of a Pi session. ACP processes are commonly terminated with their editor connection and therefore cannot be authoritative.

## Decision

Pi-Tai Host Agent is the sole broker authority. It owns session actors, the event store, revisions, operation deduplication, client attachments, and runtime-worker supervision.

`pi-tai-acp` and every other client are disposable protocol adapters. Runtime workers own live Pi SDK objects but no broker database. A client disconnect never implies session cancellation.

## Consequences

- A complete Host Agent failure can interrupt a turn, but durable history recovers honestly.
- Local IPC must be authenticated and versioned.
- Clients reconstruct state from Host snapshots and events rather than private local databases.
- Process boundaries can be tested independently.
