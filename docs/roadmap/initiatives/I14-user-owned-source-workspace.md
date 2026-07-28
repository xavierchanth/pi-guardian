# I14 — The source workspace belongs to the user

**Status:** Planned  
**Depends on:** I06, I08. Start after I13 checkpoint 4.

## Outcome

The main workspace is free to be used. `@-` is the stable identity that parallel work branches from
and rebases back onto; `@` is the user's live working change and is never described, relabelled, or
rewritten by Pi-Tai. The orchestrator treats its workspace as shared on the same terms as any other
shared source: it owns the workspace as orchestrator, but subagents it spawns in-workspace are peers
under the same file-set claim discipline. `ensure_wip_change` is removed.

## The rule the rest of the system already follows

Every document except the shared-source lane already states this:

| Source | Statement |
|---|---|
| `README.md:81` | "Child workspace creation branches from recorded source `@-`, so source `@` may contain ongoing work." |
| `docs/concurrency/JJ.md:90` | "The orchestrator allocates from source `@-`, preserving source `@` bytes and Change ID" |
| `docs/concurrency/JJ.md:22-30` | Host session workspaces are created "based on the invoking workspace's `@-`", with "invoking user `@` (preserved)" as a sibling |
| `docs/concurrency/JJ.md:140` | Manual rebase targets "source `@-` or one exact local Change ID" |
| `docs/concurrency/STATE-MACHINES.md:153` | "Source workspace creation branches from source `@-` and preserves source `@`." |
| `docs/concurrency/TESTING.md:60` | "allocation from source `@-` preserves dirty source `@`" |
| `docs/concurrency/README.md:23`, `docs/GLOSSARY.md:27` | isolated lane is "from source `@-`" |
| `docs/concurrency/TOOLS.md:39`, `I07`, `I09` | allocation from source `@-` |

I06 delivered the shared lane as the sole dissenter: it preserves "the orchestrator's private WIP change"
by seizing `@`.

## Problem

`SharedJjOperations.ensureWip` (`jj/shared-operations.ts:52-134`) requires the source workspace's
`@` to carry a Pi-Tai-managed `wip:`/`private:` description, running
`jj describe --message "wip: orchestrator workspace"` on it if it does not (`:100-108`, constant at
`:17`). `insertChange` refuses without a stored `wip` record (`:149-154`). Three blockers exist only
to defend that label:

| Site | Blocker | Trigger |
|---|---|---|
| `:87-92` | `decision_required` | `@` holds unknown nonempty work and cannot be relabelled |
| `:70-72` | `foreign_work` | recorded WIP Change ID lost its managed description |
| `:111-113` | `unknown` | describe completed without the expected description postcondition |

The `decision_required` case is the live friction: the orchestrator cannot start while the user has real
uncommitted work in `@`. `ensure_wip_change` is also agent-callable, so the ceremony is a step the
model must remember.

## Root cause — one field doing two jobs

`wipChangeId` conflates two roles, and the `wip:` label exists only to make the conflation safe:

| Role | Correct value | Why |
|---|---|---|
| **Base** — what parallel work branches from and rebases onto, and what targets are inserted after | `@-` | Durable; does not move as the user edits. Already the documented anchor for every other lane. |
| **Working change** — whose content is checkpointed into an assigned target | `@` | The live working copy is where edits land. Observed, never described, never rewritten. |

In the isolated lane the two coincide, which is why that lane needs no label: Pi-Tai created the
workspace head itself, so `identity.expectedHeadChangeId` is simultaneously the insertion point
(`jj/workspace-file-sets.ts:45`) and the content source (`:27`).
`WorkspaceClaimStoreAdapter.project` (`:94`) then synthesizes a `wip` record from that head with a
fabricated description that nothing reads. In the source workspace the roles must not coincide,
because `@` is the user's. Splitting them removes the need for the label entirely.

The evidence that actually protects integration is already identity- and content-based, not
label-based: `jj/workspace-integration.ts:15` pins `sourceWipChangeId` plus `sourcePatchHash` and
re-verifies both at `:27`. It does not consult the description.

## Scope

1. **Record the base explicitly.** `JjRepositoryKernel.inspect` (`jj/repository.ts:105-113`)
   resolves only `@`; `ResolvedJjChange.parentChangeIds` is already populated by `CHANGE_TEMPLATE`
   (`:16`). Add a `base` to `SourceInspection` derived from `current.parentChangeIds`, requiring
   **exactly one parent** — a merge `@` has no unambiguous `@-` and must block as
   `decision_required` rather than pick a side, per the identity rule at `docs/concurrency/JJ.md:19`.
2. **Anchor `insertChange` on the base.** Replace the `inspected.source.wip` lookup
   (`shared-operations.ts:142,149`) with the inspected base. The insertion command is unchanged —
   inserting before `@` *is* creating a child of `@-` — but the recorded and verified identity
   becomes `@-`, so a user amending, describing, or abandoning `@` no longer invalidates it.
3. **Keep `@` as the content source, observed only.** `verifyBaseline`
   (`concurrency/file-sets.ts:304`, `jj/workspace-file-sets.ts:24-29`) continues to read the live
   working change, resolved at operation time; never described or rewritten.
4. **Delete `ensureWip` and `DEFAULT_WIP_DESCRIPTION`.** Remove `WipEnsurer` from
   `SharedJjOperations` and from `jj/operations.ts`; remove `EnsureWipReceipt` and
   `isWipDescription`.
5. **Retire the three label blockers.** `identity_mismatch`, `immutable`, `conflicted`, and
   `unknown` remain; the new single-parent check joins them.
6. **Split the persisted field.** `PersistedSharedSourceV1.wip` becomes per-target `baseChangeId`
   (was `wipChangeId`, `concurrency/file-sets.ts:97,417`) and `workingChangeId` (`:304`).
   `sourceWipChangeId` / `sourcePatchHash` in `PersistedIntegrationAttemptV1`
   (`jj/workspace-persistence.ts:64`) become `sourceWorkingChangeId` / `sourceWorkingPatchHash`.
   One migration, not several.
7. **Rewrite the adapter projection.** `WorkspaceClaimStoreAdapter.project` loses its fabricated
   `wip` record and supplies `baseChangeId === workingChangeId === identity.expectedHeadChangeId`,
   which is the truth for an isolated workspace. Its stable-identity assertion (`:79`) moves to the
   surviving fields.
8. **Remove the `ensure_wip_change` tool.** `subagents/register.ts:1053-1061`,
   `subagents/domain.ts:21`, `subagents/agents.ts:73`, `packages/pi-tai/agents/orchestrator.md`.

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

- The orchestrator starts and inserts targets against a source workspace whose `@` holds arbitrary
  nonempty user work with a user-authored description; nothing runs `describe` on it, and the `@`
  Change ID, description, and bytes are unchanged afterwards.
- Amending or re-describing `@` mid-flight does not invalidate an outstanding target or claim.
- A merge `@` blocks with `decision_required` rather than choosing a parent.
- No production path calls `ensureWip`; `grep -rn ensure_wip packages services` is empty.
- Integration still fails closed when the source working change's identity or patch hash changes.
- Two children sharing the source workspace under distinct file-set claims behave identically to two
  children sharing one isolated workspace today.
- Real-JJ tests cover a dirty, user-described, nonempty source `@` for the full shared path.
