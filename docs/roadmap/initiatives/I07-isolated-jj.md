# I07 — Isolated JJ execution

**Status:** Complete  
**Depends on:** I05, I06

## Implemented foundation

M3 now has a dedicated versioned isolated-workspace store under `jj-workspaces`. It is authoritative for allocation intent, source/root/head identity, writer generations, operation receipts, frozen reports, and incidents. New SDK workspace children retain only `workspaceId`; legacy attachments are compatibility projections.

Delivered implementation includes:

- pre-mutation allocation intent and exact creation from source `@-`;
- source WIP Change-ID and patch-evidence preservation checks;
- tracked linked-workspace repository access sharing the repository mutation mutex;
- context-bound writer leases, atomic transfer, restart interruption, and isolated write/shell guards;
- checkpoint receipts that consume the old lease and issue a fresh same-owner lease on one empty child;
- explicit exact-target workspace rebase with identity/order and patch disposition evidence;
- safe interior-empty normalization and exact description targets;
- report freeze into a state that cannot contain writer authority;
- exact root/head/content-tip derivation and entirely-empty range proof;
- production tools for checkpoint, normalization, rebase, and report preparation;
- a hard boundary preventing the legacy integration path from consuming tracked work before I08 review gating.

Real-JJ tests cover dirty-source allocation, repeated identity tracking, checkpoint lease renewal, equivalent and conflicted rebase, interrupted allocation/checkpoint/rebase/normalization reconstruction, identity drift, foreign descendants, nonempty freeze, and no-change freeze. Strict persistence tests reject cross-phase authority and identity mismatches. Oversized evidence moves to immutable content-addressed workspace artifacts with centralized inline and aggregate limits.

## Outcome

The Orchestrator can allocate tracked isolated JJ workspaces; Implementation Leads, Documenters, and Workers checkpoint coherent units under scoped ownership; workspaces can rebase explicitly, freeze exact review boundaries, and prove no-effect work.

## Work slices

1. **Delivered:** authoritative workspace persistence and exact linked-workspace repository access.
2. **Delivered:** allocation from source `@-` with source WIP/root/head identity capture and startup-failure custody.
3. **Delivered:** workspace-wide writer leases, parent/child transfer, guarded mutation, and exact checkpoint head transitions.
4. **Delivered:** manual `rebase_workspace` onto source parent/exact local Change ID.
5. **Delivered:** safe empty/naming normalization, report freeze, content-tip derivation, and no-change proof.
6. **Delivered:** restart reconciliation reconstructs matching allocation, checkpoint, rebase, and normalization boundaries; safe-to-resume and attention-required states remain explicit.
7. **Delivered:** bounded immutable content-addressed range artifacts plus Real-JJ interruption, conflict, identity-drift, foreign-descendant, and no-change fixtures.

## Required proofs

- dirty source remains byte-for-byte and Change-ID stable at allocation;
- repeated checkpoints leave named changes plus exactly one expected empty head;
- unexpected unreceipted head stops writes;
- rebase preserves root/content-tip/head IDs and exact range order;
- clean equivalent rebase refreshes evidence; changed patch stales review; conflicts retain custody;
- child-start failure, name collision, stale workspace, and foreign descendants preserve recoverable state;
- entirely empty range closes without synthetic history.

## Exit criteria

- Implementation Leads, Documenters, and Workers cannot create nested workspaces or use arbitrary JJ mutation.
- Every frozen report has exact root/head/content-tip and no live writer.
- One workspace has at most one writable context.
- Workspace rebase never fetches or publishes.
- Real-JJ tests cover normal, conflict, interruption, and identity-drift cases.
