# Roadmap

## Purpose

The roadmap describes how the current repository converges on the end-state product and architecture. Unlike the rest of the documentation, roadmap files deliberately contain status, sequencing, migration constraints, and temporary compatibility work.

An initiative is a bounded product or architecture outcome. It may contain many implementation checkpoints. Initiative numbers provide a stable reading order, not a promise of strictly serial delivery.

## Current focus

[I13](initiatives/I13-host-configuration-authority.md) is the active initiative and the forcing function for I01. Checkpoints 1–5 are complete; **checkpoint 6 (Host policy resolution and runtime transport) is in flight**. I13 also reshapes the scope of I01, I02, I03, I04, and I10 — read it before planning against those. The I13 checkpoint 4 start gates for I14 and I15 are satisfied; coordinate their configuration and composition changes with checkpoint 6 while it remains in flight.

## Status legend

- **Complete** — accepted outcome exists and dependents may rely on it.
- **In progress** — active implementation exists but exit outcome is not complete.
- **Planned** — designed enough to index; implementation has not started.
- **Exploratory** — outcome is desired but key product decisions remain.

## Initiative index

| ID | Initiative | Status | Depends on | End outcome |
|---|---|---|---|---|
| I00 | [Documentation, repository, and toolchain alignment](initiatives/I00-documentation-and-repository.md) | Planned | — | New docs become normative; top-level areas have explicit product status; formatter, linter, and CI enforce the gate |
| I01 | [Extract the shared core](initiatives/I01-core-extraction.md) | Planned | I00 | Reusable behavior lives in `@pi-tai/core`; Pi-specific presentation is an adapter |
| I02 | [Canonical Host sessions](initiatives/I02-host-session-authority.md) | In progress | I00 | Host owns durable sessions, resolved policy, events, and replay |
| I03 | [Host/runtime convergence](initiatives/I03-host-runtime-convergence.md) | In progress | I01, I02 | Host-supervised worker consumes pinned policy and holds no competing authority |
| I04 | [ACP client contract and CLI cutover](initiatives/I04-local-client-contract.md) | Planned | I02, I03 | `pi-tai-client`, Zed, and T3 Code share one Host-backed ACP session surface |
| I05 | [Concurrency runtime foundation](initiatives/I05-concurrency-foundation.md) | Complete | — | Strict types, Real-JJ harness, private SDK children, push/recovery foundation |
| I06 | [Shared-source JJ concurrency](initiatives/I06-shared-jj.md) | Complete | I05 | Atomic file-set queues and deterministic WIP/feature checkpoints |
| I07 | [Isolated JJ execution](initiatives/I07-isolated-jj.md) | Complete | I05, I06 | Tracked workspace identity, checkpoint, rebase, freeze, and no-change proof |
| I08 | [Review, integration, and recovery](initiatives/I08-review-integration-recovery.md) | Complete | I06, I07 | Task-plan review gate, deterministic integration, conflict repair, recovery |
| I09 | [Concurrency productization](initiatives/I09-concurrency-productization.md) | Complete | I08 | Honest closure/UI/accounting and deletion of production compatibility paths |
| I10 | [Desktop and ACP clients](initiatives/I10-desktop-acp.md) | In progress | I04 | Desktop manages the Host; Zed, T3 Code, and `pi-tai-client` consume the ACP surface |
| I11 | [Remote and multi-Host access](initiatives/I11-remote-multihost.md) | Exploratory | I04, I10 | Authenticated remote clients with one home Host per session |
| I12 | [Stateful machine capabilities](initiatives/I12-machine-capabilities.md) | Exploratory | I02, I03, I04 | Browser/computer/image/cmux capabilities governed and persisted uniformly |
| I13 | [Host configuration authority](initiatives/I13-host-configuration-authority.md) | In progress | I02, I03 | Policy is resolved once, pinned into the session aggregate, provenanced, and privilege-enforced |
| I14 | [The source workspace belongs to the user](initiatives/I14-user-owned-source-workspace.md) | Planned | I06, I08 | Source `@` is the user's; the shared lane anchors on `@-`; `ensure_wip_change` is gone |
| I15 | [Session presence: notifications and cmux sidebar](initiatives/I15-session-awareness-affordances.md) | Planned | I13 | Notifications identify session and outcome; cmux sidebar carries live session status |
| I16 | [`/btw` sidebar query](initiatives/I16-sidebar-query.md) | Planned | I13 | A question answered with full session context that leaves no trace in it |

## Dependency graph

```mermaid
graph TD
  I00[I00 Docs/repository alignment]
  I01[I01 Shared core]
  I02[I02 Host session authority]
  I03[I03 Host/runtime convergence]
  I04[I04 Local client contract]
  I05[I05 Concurrency foundation — complete]
  I06[I06 Shared JJ — complete]
  I07[I07 Isolated JJ]
  I08[I08 Review/integration/recovery]
  I09[I09 Concurrency productization]
  I10[I10 Desktop and ACP]
  I11[I11 Remote/multi-Host]
  I12[I12 Stateful capabilities]
  I13[I13 Host configuration authority]
  I14[I14 User-owned source workspace]
  I15[I15 Session presence]
  I16[I16 /btw sidebar query]

  I00 --> I01
  I00 --> I02
  I01 --> I03
  I02 --> I03
  I02 --> I04
  I03 --> I04
  I02 --> I13
  I03 --> I13
  I13 --> I01
  I13 --> I04
  I13 --> I15
  I13 --> I16

  I05 --> I06
  I05 --> I07
  I06 --> I07
  I06 --> I08
  I07 --> I08
  I08 --> I09
  I06 --> I14
  I08 --> I14

  I04 --> I10
  I04 --> I11
  I10 --> I11
  I02 --> I12
  I03 --> I12
  I04 --> I12
```

Concurrency/JJ and Host/core work can proceed in parallel. Their convergence point is persistence and runtime composition: child/context/workspace state must ultimately be persisted through Host-owned session services rather than a second standalone authority.

## Suggested delivery lanes

| Lane | Sequence |
|---|---|
| Documentation/repository | I00 → I01 |
| Host authority | I02 → I03 → I13 → I04 |
| Concurrency/JJ | I05 → I06 → I07 → I08 → I09 → I14 |
| Clients | I04 → I10 → I11 |
| Machine capabilities | {I02, I03, I04} → I12 |
| Session affordances | I13 → {I15, I16} |

I13 is the forcing function for I01: core extraction stalled because nothing required it, and configuration is the one place Pi's ownership is load-bearing rather than incidental.

## Migration rules

1. Preserve behavior behind interfaces before moving directories.
2. Keep one authoritative state owner during every cutover; mirroring is temporary and explicit.
3. Add protocol/persistence version adapters before deleting legacy records.
4. Do not combine broad repository moves with security-sensitive behavior changes.
5. Every initiative has independently testable exit outcomes.
6. Compatibility code has a named deletion initiative and no new callers.
7. Historical docs are removed only after their enduring decisions appear in the new normative set.
8. Generated outputs and obsolete archives are not retained merely because they once shipped.
