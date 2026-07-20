# ADR 0002: Valid mutations transfer active-client control immediately

- Status: Accepted
- Date: 2026-01-15

## Context

The primary use case is one person moving between Zed, desktop, and mobile. Confirmation-based takeover would prevent cancellation or answering a question after walking away from the previous device. Allowing clients to mutate independent state would create divergence and races.

## Decision

Every authenticated client may submit supported state-changing commands to the Host session actor. A valid, durably accepted mutation immediately makes that client the active client. There is no takeover confirmation or user-configurable policy.

Commands carry an operation ID and expected session revision. The actor serializes commands. When concurrent commands use the same revision, the first durable command wins and advances the revision; competing commands receive a conflict and current state. Interaction answers and cancellation use durable target IDs and are idempotent.

`activeClientId` and `controlEpoch` are retained for attribution, routing, and invalidating delayed work, not as a permission lease.

## Consequences

- Handoff requires no separate command.
- Clients must handle conflict responses and intentional retry.
- Only one prompt turn runs at a time.
- Security depends on client authentication, not controller identity.
