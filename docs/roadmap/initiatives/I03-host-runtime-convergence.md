# I03 — Host/runtime convergence

**Status:** In progress  
**Depends on:** I01, I02

## Existing foundation

A TypeScript Pi runtime helper, runtime protocol in Rust/TypeScript, packaging experiments, supervisor, process tests, and Pi SDK session proofs exist. The concurrency runtime also creates private SDK child sessions in-process.

## Outcome

A Host-supervised runtime worker embeds the same Pi-Tai core used by clients/tests. The Host owns product state; the worker owns live Pi SDK contexts and private journals only.

## Scope

- Compose `@pi-tai/core` inside `services/pi-runtime`.
- Define versioned Host↔worker commands/events and generation identity.
- Map root and child SDK context events to canonical Host events.
- Reconstruct contexts from Host state plus private journals.
- Implement quiescence proof before replacing a failed/stalled worker.
- Reconcile interrupted read-only and mutating tool calls from receipts.
- Package a self-contained runtime worker without user-managed Node.
- Remove direct source-tree runtime paths from production packaging.
- Decide worker granularity (per Host/session/group) from isolation and telemetry, not domain identity.

## Exit criteria

- Worker crash cannot erase or supersede Host session truth.
- Old and replacement writers cannot run simultaneously.
- One runtime generation maps unambiguously to Host state.
- Root and child compaction/recovery work after process restart.
- Runtime protocol fixtures and generated bindings agree.
- No parallel session policy remains in Host Rust and worker TypeScript.
