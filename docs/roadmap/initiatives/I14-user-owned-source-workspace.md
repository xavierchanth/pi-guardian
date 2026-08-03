# I14 — The source workspace belongs to the user

**Status:** Completed  
**Depends on:** I06, I08. (The former I13 start gate was satisfied before I13 retired.)

**Superseded:** The delegation model described here — named agent roles, durable work orders, and the review, integration, and recovery tool families — was replaced by the subagent and workspace design in [docs/concurrency/README.md](../../concurrency/README.md). This document is kept as a record of what was built at the time and is not a description of the current system.

## Outcome

Completed in the I14 shared consolidation: the shared lane now records distinct base and working-change identities, validates and strips legacy managed-WIP records, and has no `ensure_wip_change` runtime/tool surface.

The main workspace is free to be used. `@-` is the stable identity that delegated work branches from
and rebases back onto; `@` is the user's live working change and is never described, relabelled, or
rewritten by Pi-Tai. The Orchestrator has no source-editing authority: after persisting a clear plan it
may allocate an isolated Implementation Lead or Documenter workspace from `@-` without user approval,
then integrate only independently reviewed work before the preserved user change. `ensure_wip_change` is removed.

## The rule the rest of the system already follows

Every document except the shared-source lane already states this. The `docs/concurrency/` documents
cited below have since been consolidated into a single [concurrency overview](../../concurrency/README.md),
so they are named here without links:

| Source | Statement |
|---|---|
| [`README.md`](../../../README.md) | Child workspace creation branches from recorded source `@-`, so source `@` may contain ongoing work. |
| `docs/concurrency/JJ.md` | The Orchestrator allocates from source `@-`, preserving source `@` bytes, description, and Change ID. |
| `docs/concurrency/STATE-MACHINES.md` | Source workspace creation branches from source `@-` and preserves source `@`. |
| `docs/concurrency/TESTING.md` | Allocation from source `@-` preserves dirty source `@`. |
| [`docs/concurrency/README.md`](../../concurrency/README.md) and [`docs/GLOSSARY.md`](../../GLOSSARY.md) | The isolated lane starts from source `@-`. |
| `docs/concurrency/TOOLS.md`, [I07](I07-isolated-jj.md), and [I09](I09-concurrency-productization.md) | Workspace allocation uses source `@-`; review and integration preserve source `@`. |

I06 delivered the shared lane as the sole dissenter: it preserves "the orchestrator's private WIP change"
by seizing `@`.

## Superseded implementation

Before I14, `SharedJjOperations.ensureWip` in `packages/pi-tai/src/jj/shared-operations.ts` required the source
workspace's `@` to carry a Pi-Tai-managed `wip:`/`private:` description, running
`jj describe --message "wip: orchestrator workspace"` when it can safely adopt the change.
`insertChange` refuses without a stored `wip` record. Three blockers exist only to defend that label:

| Blocker | Trigger |
|---|---|
| `decision_required` | `@` holds unknown nonempty work and cannot be relabelled |
| `foreign_work` | recorded WIP Change ID lost its managed description |
| `unknown` | describe completed without the expected description postcondition |

The `decision_required` case is the live friction: isolated delegation cannot start while the user has
real uncommitted work in `@`. Although `ensure_wip_change` is no longer exposed to the Orchestrator,
the workspace-allocation runtime still invokes the same operation internally, so the obsolete label
remains a hidden execution precondition.

## Resolved root cause — one field was doing two jobs

`wipChangeId` conflates two roles, and the `wip:` label exists only to make the conflation safe:

| Role | Correct value | Why |
|---|---|---|
| **Base** — what parallel work branches from and rebases onto, and what targets are inserted after | `@-` | Durable; does not move as the user edits. Already the documented anchor for every other lane. |
| **Working change** — whose content is checkpointed into an assigned target | `@` | The live working copy is where edits land. Observed, never described, never rewritten. |

In the isolated lane the two coincide, which is why that lane needs no label: Pi-Tai created the
workspace head itself, so `identity.expectedHeadChangeId` is simultaneously the insertion point and
the content source in `jj/workspace-file-sets.ts`. `WorkspaceClaimStoreAdapter.project` then
synthesizes a `wip` record from that head with a fabricated description that nothing reads. In the
source workspace the roles must not coincide, because `@` is the user's. Splitting them removes the
need for the label entirely.

The evidence that actually protects integration is already identity- and content-based, not
label-based: `jj/workspace-integration.ts` pins `sourceWipChangeId` plus `sourcePatchHash` and
re-verifies both. It does not consult the description.

## Scope

1. **Record the base explicitly.** `SharedJjOperations.insertChange` derives the base from the
   operation-time `current.parentChangeIds`, requiring **exactly one parent** — a merge `@` has no
   unambiguous `@-` and blocks as `decision_required` rather than picking a side.
2. **Anchor `insertChange` on the base.** Replace the `inspected.source.wip` lookup in
   `jj/shared-operations.ts` with the inspected base. The insertion command is unchanged — inserting
   before `@` *is* creating a child of `@-` — but the recorded and verified identity becomes `@-`,
   so a user amending, describing, or abandoning `@` no longer invalidates it.
3. **Keep `@` as the content source, observed only.** `verifyBaseline` in
   `concurrency/file-sets.ts` and `jj/workspace-file-sets.ts` continues to read the live working
   change, resolved at operation time; never described or rewritten.
4. **Delete `ensureWip` and `DEFAULT_WIP_DESCRIPTION`.** Remove `WipEnsurer` from
   `SharedJjOperations` and from `jj/operations.ts`; remove `EnsureWipReceipt` and
   `isWipDescription`.
5. **Retire the three label blockers.** `identity_mismatch`, `immutable`, `conflicted`, and
   `unknown` remain; the new single-parent check joins them.
6. **Split the persisted field.** `PersistedSharedSourceV1.wip` becomes per-target and per-claim
   `baseChangeId` and `workingChangeId`. Validation migrates legacy `wipChangeId` records and strips
   legacy `wip` metadata and `ensure_wip` operations. Isolated integration custody already stopped
   persisting source working/base observations in the inherited baseline.
7. **Rewrite the adapter projection.** `WorkspaceClaimStoreAdapter.project` loses its fabricated
   `wip` record and supplies `baseChangeId === workingChangeId === identity.expectedHeadChangeId`,
   which is the truth for an isolated workspace. Its stable-identity assertion moves to the surviving
   fields.
8. **Remove `ensure_wip_change` from the runtime contract.** Delete its registration and domain operation, remove the allocation-time internal call, and retain no packaged-role dependency on it.

## Migration constraints

- Per migration rule 3, land the persisted-schema adapter before deleting the legacy `wip` record.
- Per migration rule 1, the insertion graph must not change shape; only the recorded identity does.
- I06's delivered invariants for claims, checkpoints, and receipts are preserved unchanged. Only the
  WIP-label invariants are retired.

## Canonical documentation

The future-first concurrency specification already defines source `@-` as the stable base and source
`@` as the preserved user working change. This initiative tracks the implementation and persistence
migration needed to match that authority. I06 retains its WIP-label history only as delivered-state
context and explicitly marks those invariants as superseded by I14.

## Exit criteria

- The Orchestrator can allocate plan-bound Implementation Lead or Documenter work against a source workspace whose `@` holds arbitrary nonempty user work with a user-authored description; nothing runs `describe` on it, and the `@` Change ID, description, and bytes are unchanged afterwards.
- Amending or re-describing `@` mid-flight does not invalidate an outstanding target or claim.
- A merge `@` blocks with `decision_required` rather than choosing a parent.
- The managed source-WIP operation and tool are absent; the production-tree verification command documented for I14 is empty.
- Integration still fails closed when the source working change's identity or patch hash changes.
- Implementation Leads and Documenters remain isolated from the source workspace throughout implementation and review; only deterministic integration mutates the graph around the preserved source working change.
- Real-JJ tests cover a dirty, user-described, nonempty source `@` across allocation, review-gated integration, and verification.
