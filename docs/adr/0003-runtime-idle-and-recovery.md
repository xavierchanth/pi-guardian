# ADR 0003: Unload idle runtimes and recover interrupted turns explicitly

- Status: Accepted
- Date: 2026-01-15

## Context

Keeping every Pi SDK runtime alive indefinitely wastes memory, while replaying an interrupted prompt can duplicate tool side effects. Broker session history must outlive runtime processes.

## Decision

A loaded runtime becomes unload-eligible after 30 minutes with no active/queued turn, pending interaction, durable command application, or recovery operation. Client attachment alone does not prevent unload.

Unload disposes the Pi runtime worker but retains Host events, projections, snapshots, work context, title, and Pi session-file mapping. The next runtime-requiring command reloads it.

Worker or Host failure during a turn records an interrupted state. Pi-Tai never automatically resubmits the last prompt; the user explicitly continues from recovered history.

## Consequences

- Runtime startup must be fast and observable.
- Tests require an injected clock and deterministic worker lifecycle.
- Interrupted and idle-unloaded states are distinct.
- Session deletion and retention remain separate product operations.
