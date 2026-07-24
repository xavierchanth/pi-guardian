# I07 — Isolated JJ execution

**Status:** Planned  
**Depends on:** I05, I06

## Existing foundation

Pre-M3 workspace behavior includes JJ-only creation from source `@-`, dirty-source preservation, root-only allocation/integration, Change-ID ancestry checks, empty-revision handling, workspace rebase design contracts, and workspace evaluation fixtures. These are inputs and compatibility behavior, not completion of the target initiative. The M3 tracked root/head/content-tip lifecycle, workspace writer lease, deterministic checkpoint/rebase implementation, and freeze tools remain to be delivered.

## Outcome

The thinker can allocate tracked isolated JJ workspaces; planners/workers checkpoint coherent units under one writer token; workspaces can rebase explicitly, freeze exact review boundaries, and prove no-effect work.

## Work slices

1. Workspace allocation from source `@-` with source WIP/root/head identity capture.
2. Workspace-wide writer token and `workspace_checkpoint` exact head transitions.
3. Atomic workspace child startup with durable custody on failure.
4. Manual `rebase_workspace` onto source parent/exact local Change ID.
5. `prepare_workspace_report` freeze and content-tip derivation.
6. Exact inclusive range/conflict inspection and bounded artifacts.
7. Safe empty/naming normalization and no-change proof.

## Required proofs

- dirty source remains byte-for-byte and Change-ID stable at allocation;
- repeated checkpoints leave named changes plus exactly one expected empty head;
- unexpected unreceipted head stops writes;
- rebase preserves root/content-tip/head IDs and exact range order;
- clean equivalent rebase refreshes evidence; changed patch stales review; conflicts retain custody;
- child-start failure, name collision, stale workspace, and foreign descendants preserve recoverable state;
- entirely empty range closes without synthetic history.

## Exit criteria

- Planner/worker cannot create nested workspaces or use arbitrary JJ mutation.
- Every frozen report has exact root/head/content-tip and no live writer.
- One workspace has at most one writable context.
- Workspace rebase never fetches or publishes.
- Real-JJ tests cover normal, conflict, interruption, and identity-drift cases.
