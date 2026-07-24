# I04 — Local client contract and CLI cutover

**Status:** Planned  
**Depends on:** I02, I03

## Outcome

Pi CLI, desktop, ACP, and diagnostic clients use one typed Host command/query/event contract over authenticated local IPC. The Pi CLI no longer owns Host-managed session persistence.

## Scope

- Stabilize transport-neutral command/query/event semantics.
- Add operation IDs, expected revisions, cursors, capability negotiation, and error taxonomy.
- Build shared connection/replay client code when two callers justify it.
- Adapt the current Pi extension to create/attach/resume Host sessions.
- Project Host events into Pi TUI while keeping ANSI themes, footer, editor, keybindings, and notifications local.
- Define explicit standalone unmanaged Pi behavior during migration; never silently switch authorities.
- Add local enrollment/authentication and protocol-version handshake.
- Prove reconnect and backpressure.

## Exit criteria

- Closing Pi CLI detaches without ending Host work.
- Reopening from a cursor receives no duplicate/lost durable event.
- Terminal-specific behavior remains absent from headless/ACP/runtime modes.
- Clients cannot open Host storage or private journals directly.
- Host-unavailable, auth, stale revision, and version mismatch are actionable.
- At least Pi CLI and one second client consume the same contract.
