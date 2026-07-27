# Concurrency state machines and invariants

This document is normative. Boundary DTOs may be migration-tolerant; conversion to internal states must reject or quarantine invalid combinations.

## Runtime invariants

- One Host-owned root session has one thinker and one isolated coordinator.
- Every child has exactly one direct parent and one immutable role/task authority snapshot.
- Child contexts are private Pi SDK contexts, not user-selectable sessions.
- Task goals, assignments, directions, and plan revisions are append-only; the latest plan revision is the sole effective plan.
- Planner projections expose only their owned subtree's effective plans; worker projections expose only effective plans on their authority lineage.
- Thinker projections and immutable reviewer snapshots expose full plan history with superseded revisions explicitly non-authoritative.
- Parent/child protocol uses hidden typed custom messages, never user-role impersonation.
- Parents receive bounded child-authored reports, never histories.
- Questions and terminal reports push; awaiting is optional.
- A delegating context cannot terminally report with unresolved or unacknowledged direct children.
- Delivery and acknowledgement are separate durable facts.
- One terminal event and one terminal acknowledgement occur at most once per execution cycle.
- Status is correlated and nonterminal.
- Root abort does not imply child cancellation.
- Replacement writers require proof that old writers are quiescent.

## Child lifecycle

```ts
type ChildExecution =
  | { phase: "created"; cycleId: string }
  | { phase: "starting"; cycleId: string; attemptId: string }
  | { phase: "running"; cycleId: string; resume: ResumePoint }
  | { phase: "suspended"; cycleId: string; reason: "await_children" | "await_parent"; resume: ResumePoint }
  | { phase: "stalled"; cycleId: string; lastHeartbeatAt: string; resume: ResumePoint }
  | { phase: "cancelling"; cycleId: string; requestedAt: string; reason: string; resume?: ResumePoint }
  | { phase: "recovering"; priorCycleId: string; cycleId: string; reason: string }
  | {
      phase: "terminal";
      cycleId: string;
      outcome: "completed" | "blocked" | "failed" | "cancelled" | "abandoned";
      report: BoundedChildReport;
      acknowledgement:
        | { phase: "pending"; eventId: string }
        | { phase: "acknowledged"; eventId: string; at: string; usageReceipt: UsageReceipt };
    };
```

```text
created → starting → running
starting → terminal(failed) | recovering
running ↔ suspended
running|suspended → stalled
stalled → running | recovering | terminal
running|suspended|stalled → cancelling
cancelling → terminal(cancelled) only after runtime and mutation quiescence are proved
running|suspended → terminal
terminal(pending) → terminal(acknowledged)
terminal → new linked recovering cycle only for explicit retry/repair
```

A status turn does not change semantic phase. `cancelling` is nonterminal: cancellation has been requested, but the child may still be settling an abort-aware wait or a durable mutation boundary. Restart never auto-resumes a `cancelling` cycle; missing quiescence proof becomes an explicit mutation-stopped disposition.

## Event lifecycle

```ts
type ChildEventState =
  | { phase: "queued"; event: ChildEvent }
  | { phase: "delivered"; event: ChildEvent; parentEntryId: string }
  | { phase: "acknowledged"; event: ChildEvent; usageReceipt?: UsageReceipt };
```

Every transition is idempotent by event ID. Coalescing preserves individual semantic IDs and acknowledgement.

## Shared file-set lifecycle

```ts
type FileSetClaim =
  | { phase: "queued"; claimId: string; paths: CanonicalPath[]; owner: string }
  | { phase: "active"; claimId: string; paths: CanonicalPath[]; owner: string }
  | { phase: "checkpointing"; claimId: string; targetChangeId: ChangeId; operationId: string }
  | { phase: "released"; claimId: string; receipt?: CheckpointReceipt }
  | { phase: "interrupted"; claimId: string; priorPhase: "queued" | "active" | "checkpointing"; reason: string }
  | { phase: "breached"; claimId: string; reason: string };
```

```text
queued → active → checkpointing → released
active → released only with no uncheckpointed owned changes
queued|active|checkpointing → interrupted on restart
active|checkpointing → breached on ownership bypass
```

Overlapping requests queue; no partial grant exists.

## Isolated workspace file-claim lifecycle

```ts
type WorkspaceFileClaim =
  | { phase: "queued"; workspaceId: string; claimId: string; owner: string; paths: CanonicalPath[] }
  | { phase: "active"; workspaceId: string; claimId: string; owner: string; paths: CanonicalPath[]; targetChangeId: ChangeId }
  | { phase: "checkpointing"; workspaceId: string; claimId: string; owner: string; paths: CanonicalPath[]; targetChangeId: ChangeId; operationId: string }
  | { phase: "released"; workspaceId: string; claimId: string; receipt?: CheckpointReceipt }
  | { phase: "interrupted"; workspaceId: string; claimId: string; priorPhase: "queued" | "active" | "checkpointing"; reason: string }
  | { phase: "breached"; workspaceId: string; claimId: string; reason: string };
```

Each workspace coordinates claims independently. A file/path region has at most one active owner within one workspace, while disjoint claims may write concurrently. Complete sets grant atomically. Checkpoint moves only claimed paths into the assigned target and releases after receipt persistence. Restart interrupts ownership; it never restores a live claim.

## Workspace custody lifecycle

```ts
type WorkspaceCustody =
  | { phase: "allocating"; allocationId: string }
  | { phase: "active"; attachment: WorkspaceIdentity; ownerContextId: string }
  | { phase: "reported"; attachment: WorkspaceIdentity; report: WorkspaceReportReceipt }
  | { phase: "acknowledged"; attachment: WorkspaceIdentity; report: WorkspaceReportReceipt }
  | { phase: "reviewing"; attachment: WorkspaceIdentity; bundle: ReviewBundle }
  | { phase: "changes_requested"; attachment: WorkspaceIdentity; review: ReviewerReport; cycle: number }
  | { phase: "approved"; attachment: WorkspaceIdentity; receipt: ReviewReceipt }
  | { phase: "integrating"; attachment: WorkspaceIdentity; receipt: ReviewReceipt; attempt: IntegrationAttempt }
  | { phase: "conflict_resolution"; attachment: WorkspaceIdentity; integration: IntegrationReceipt; review: ReviewerReport }
  | { phase: "integrated"; attachment: WorkspaceIdentity; receipt: IntegrationReceipt }
  | { phase: "verifying"; integration: IntegrationReceipt; verificationId: string }
  | { phase: "closed"; integration: IntegrationReceipt; verification: VerificationReceipt }
  | { phase: "closed_no_changes"; proof: EmptyRangeProof }
  | { phase: "cleanup_pending"; outcome: "closed" | "closed_no_changes"; reason: string }
  | { phase: "attention_required"; incident: WorkspaceIncident };
```

```text
allocating → active → reported → acknowledged → reviewing → approved
reviewing → changes_requested → active       (bounded cycle)
reviewing → closed_no_changes
approved → integrating → integrated → verifying → closed
integrating → conflict_resolution → integrated
closed|closed_no_changes → cleanup_pending when only cleanup remains
```

`attention_required` has no automatic outgoing mutation transition.

## Coupling invariants

- `reported` requires frozen exact root/head/content tip and no live writer.
- `acknowledged` requires parent event acknowledgement.
- `approved` binds task-plan hash, exact expected head, inclusive range, and normalized patches.
- Commit-ID-only rewriting does not invalidate approval.
- Patch change requires review.
- `integrating` holds repository mutation authority.
- `closed` requires JJ and product verification.
- `closed_no_changes` requires an empty-range proof.
- Ending/cancelling execution never implicitly deletes custody.

## JJ invariants

- Managed backend is JJ only.
- Source workspace creation branches from source `@-` and preserves source `@`.
- Tracked root, head, content-tip, source base, source working-change, and feature IDs resolve exactly once.
- Workspace rebase preserves tracked range identity and order.
- Review covers the complete inclusive root-to-content-tip range.
- Every nonempty isolated range has reviewer evidence before integration.
- Integration preserves the source working change's Change ID, description, and content; Pi-Tai never describes or rewrites it.
- No-op work creates no synthetic revision.
- Models never assemble mutating command sequences.
- No automatic publish, config mutation, destructive cleanup, or backend fallback.

## Invalid combinations

Implementation must make these unrepresentable or reject them:

- terminal child without bounded report;
- duplicate terminal result or acknowledgement;
- status treated as terminal;
- replacement writer before prior writer quiesces;
- shared mutation without complete active claim;
- partial file-set grant;
- released claim with uncheckpointed owned changes;
- checkpoint into unassigned Change ID;
- isolated write without writer token;
- token release before new head receipt persists;
- reviewer with write/integration authority;
- frozen report without root/head/content tip;
- approval without task plan and normalized-patch receipt;
- integration without approval;
- conflict resolved without squash and focused-review evidence;
- closed workspace without verification;
- no-change closure containing nonempty changes;
- cleanup-pending hiding semantic failure;
- attention-required without last-safe boundary/evidence;
- child transcript in parent model context;
- descendant usage counted twice;
- cancellation deleting workspace custody.
