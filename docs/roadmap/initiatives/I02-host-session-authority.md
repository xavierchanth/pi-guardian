# I02 — Canonical Host sessions

**Status:** In progress  
**Depends on:** I00

## Existing foundation

The repository already contains Host lifecycle/platform/protocol/server/kernel crates, local IPC, broker/event-store primitives, runtime supervision, shared protocol fixtures, a diagnostic CLI, and continuity tests. Existing proofs establish important process and persistence boundaries but are not yet the canonical architecture.

## Outcome

The long-lived machine Host is the sole authority for durable Pi-Tai sessions, resolved session policy, command ordering, event cursors, replay, client attachments, foreground state, runtime health, and recovery.

## Scope

- Finalize strict Host session aggregate/state transitions.
- Persist normalized semantic events and rebuildable snapshots in SQLite WAL mode.
- Add command operation-ID dedupe and expected-revision conflict handling.
- Generate stable message/tool/terminal/plan/interaction/operation IDs before publication.
- Define client attach/detach, replay high-water mark, and live buffering.
- Separate foreground state from runtime health.
- Map Pi journal/runtime identifiers to Host session IDs without dual authority.
- Define retention for artifacts, usage, and incidents.
- Resolve policy with field provenance in the Host and pin it into the session aggregate.
- Persist `session.policy_resolved` and revision-guarded policy-change events so replay reconstructs execution policy.
- Retain one actor/serialized command queue per session.

## Exit criteria

- Accepted commands survive client disconnect and Host restart.
- Replay is ordered and duplicate-free across a live barrier.
- Corrupt snapshots rebuild from validated events.
- Client detach does not cancel healthy foreground work.
- Explicit close/cancel is durable and idempotent.
- Pi journals cannot independently resume a Host-managed session outside Host reconciliation.
- Session state and the policy it executed under have one documented source of truth.
- Mid-session file edits cannot silently alter a running session.
