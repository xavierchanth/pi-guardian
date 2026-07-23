# Agent concurrency invariants and state machines

The [blocking policy](BLOCKING_POLICY.md) controls whether a detected condition waits, refreshes, reroutes, repairs, warns, asks, or stops affected mutation. Detection is not automatically failure.

## 1. Authoritative invariants

### Runtime and context

- There is one user-visible root Pi session and one root thinker.
- Every child is a private in-process Pi SDK context with exactly one direct parent.
- Child contexts are not user-selectable Pi sessions and never appear in `/resume`, `/fork`, or `/tree`.
- No child inherits parent conversation history.
- Parent/child protocol uses typed custom messages, never user messages.
- Parents receive bounded child-authored reports, never child histories or raw tool streams.
- Questions and terminal reports are pushed; awaiting is an optional token-free barrier.
- A task packet, role snapshot, assigned shared Change ID or workspace head, and active coordination token are the child's complete authority.
- A delegating context cannot terminally report while a direct child is unresolved or unacknowledged.
- Terminal report and acknowledgement each occur at most once per execution cycle.
- Status is correlated and nonterminal.
- `/continue` recursively reconciles resumable descendants without relaunching terminal or mutation-stopped work.
- A replacement child writer cannot start until the prior writer and its mutation operations are proved quiescent.

### Writers and queues

- Read-only children require no file lock.
- Every shared-source writer must hold the complete canonical file set it may mutate.
- Overlapping shared-source file-set requests wait FIFO; overlap is not itself an error.
- Multi-file sets are granted atomically in canonical order.
- A writer re-reads after lock acquisition and after any new acquisition cycle.
- Edit, validation of affected scope, checkpoint/squash, receipt verification, and release form one critical section.
- A pre-lock file change causes refresh. A file change while its lock is held is an ownership breach.
- `checkpoint_change` and workspace integration also serialize through one repository JJ mutation mutex.
- An isolated workspace permits one writable context at a time and checkpoints only through `workspace_checkpoint`.
- `workspace_checkpoint` must record the exact previous and new workspace-head Change IDs before releasing the writer.
- No active agent edits another active owner's workspace to help or repair it.

### Roles

- The role graph is acyclic and structurally bounded.
- Only the thinker creates, integrates, closes, or disposes isolated workspaces.
- A planner always owns one isolated substantial slice and cannot create nested workspaces.
- A worker owns bounded implementation and cannot launch another writable worker.
- A reviewer is read-only, verifies plan/spec against an exact range, and cannot launch a repair worker.
- Reviewer findings return to the thinker, which owns severity policy and repair routing.

### JJ

- Managed workspaces are JJ-only.
- The main orchestration `wip:` change is private and mutable, never made immutable by Pi-Tai.
- If no WIP exists and `@` is empty, Pi-Tai may deterministically create/describe one; it never relabels unknown nonempty work silently.
- Workspace creation branches from source `@-` and leaves source `@` content and Change ID untouched.
- Durable isolated identity includes root Change ID and expected current workspace-head Change ID; report freeze additionally records the last nonempty content-tip Change ID.
- Every managed Change ID lookup is wrapped in `exactly(change_id(<id>), 1)`.
- The original base Change ID is diagnostic context, not a requirement that commit IDs or exact parent versions remain unchanged.
- Commit IDs are observed version evidence only. A commit-ID change never blocks by itself.
- The reviewable workspace range is the inclusive exact `root::content-tip` Change-ID range.
- Model-visible mutation inputs do not accept cwd, tracked Change IDs, filesets, revsets, or JJ argv; handlers inject opaque tracked handles and active claims/leases.
- Strong semantic JJ operations construct and verify complete behaviorally meaningful steps; models do not assemble command sequences.
- Production inherits user/repository JJ configuration but never mutates it, and invokes JJ `0.43.0` using built-in commands with explicit long-form options.
- Review covers the complete inclusive range, not just the child summary or latest revision.
- Every nonempty isolated range receives a reviewer report before integration.
- A clean rebase may refresh approval when Change IDs and normalized patches remain equivalent.
- Integration preserves source WIP Change ID and source WIP file content.
- Owned, unambiguous conflicts are repairable through reviewer→worker→deterministic squash→focused review.
- An unreceipted change to a tracked Change ID stops automatic mutation.
- User-authorized rebind/resume tools may recover a uniquely verified replacement without pretending it was expected.
- Divergent identity, foreign writes, unquiesced writers, and unknown partial mutation stop affected mutation.
- No-op work creates no synthetic revision.
- No automatic push, bookmark creation, user-config mutation, destructive recovery, or backend fallback occurs.

### Review

- The reviewer receives a bounded task-plan snapshot and exact root/content-tip boundaries plus expected workspace head, not thinker or planner history.
- Findings include relation (`introduced`, `in_scope_existing`, `out_of_scope_existing`) and severity.
- Only goal-blocking or clearly in-scope high findings trigger automatic repair.
- Automatic repair is limited to one implementation cycle and one focused re-review per workspace unless the user authorizes more.
- Medium/low/note findings are surfaced or deferred rather than creating an unbounded loop.

### Observability and accounting

- Active/live views contain unresolved work only; terminal descendants remain in Inactive/inspect history.
- Tree shape derives from durable parent context IDs, never display order.
- One-line objectives/selectors truncate with `…`; they do not wrap.
- Parent-model projections contain only bounded reports and lifecycle metadata.
- User UI may show richer structured diagnostics, but it does not provide a way to enter the child context.
- Hidden reasoning is never projected.
- Intrinsic usage is recorded once per assistant message/execution cycle.
- Root totals preserve provider/model, role, child-context, and execution-cycle attribution.
- Cleanup snapshots usage before deleting disposable runtime artifacts and validates canonical containment/symlinks.
- Process restart clears all live file/workspace lock ownership; durable records retain interrupted intent and mutation receipts only.

## 2. Child context lifecycle

A durable child context can have multiple execution cycles after crash recovery or review feedback.

```ts
type ChildContext = {
  id: ChildContextId;
  parentId: ChildContextId | RootSessionId;
  task: TaskPacketSnapshot;
  role: RoleSnapshot;
  execution: ChildExecution;
  events: ChildEvent[];
  usage: UsageLedger;
};

type ChildExecution =
  | { phase: "created"; cycleId: ExecutionCycleId }
  | { phase: "starting"; cycleId: ExecutionCycleId; attemptId: string }
  | { phase: "running"; cycleId: ExecutionCycleId; resume: ResumePoint }
  | { phase: "suspended"; cycleId: ExecutionCycleId; reason: "await_children" | "await_parent"; resume: ResumePoint }
  | { phase: "stalled"; cycleId: ExecutionCycleId; lastHeartbeatAt: string; resume: ResumePoint }
  | { phase: "recovering"; priorCycleId: ExecutionCycleId; cycleId: ExecutionCycleId; reason: string }
  | {
      phase: "terminal";
      cycleId: ExecutionCycleId;
      outcome: "completed" | "blocked" | "failed" | "cancelled" | "abandoned";
      report: BoundedChildReport;
      acknowledgement:
        | { phase: "pending"; eventId: ChildEventId }
        | { phase: "acknowledged"; eventId: ChildEventId; at: string; usageReceipt: UsageReceipt };
    };
```

```ts
type ResumePoint =
  | { kind: "work"; checkpoint: string }
  | { kind: "await_children"; unresolvedChildIds: ChildContextId[] }
  | { kind: "await_parent"; questionId: string };
```

Legal transitions:

```text
created → starting → running
starting → terminal(failed) | recovering
running ↔ suspended
running|suspended → stalled
stalled → running | recovering | terminal(failed|cancelled)
running|suspended → terminal
terminal(pending) → terminal(acknowledged)
terminal → recovering only as a new linked cycle for explicit review repair, not by erasing terminal history
```

A status request/event does not change these phases except for a transient saved resume point.

## 3. Child event lifecycle

```ts
type ChildEventState =
  | { phase: "queued"; event: ChildEvent }
  | { phase: "injected"; event: ChildEvent; parentEntryId: string }
  | { phase: "acknowledged"; event: ChildEvent; usageReceipt?: UsageReceipt };
```

- Question and terminal events use steer delivery and trigger an idle parent.
- Routine progress stays in non-context state.
- Multiple queued events may be coalesced for context, but each event ID remains independently acknowledged.
- Parent context receives bounded content; rich details stay outside model context.

## 4. File-set queue lifecycle

```ts
type FileSetClaim =
  | { phase: "queued"; claimId: FileSetClaimId; paths: CanonicalPath[]; owner: ChildContextId }
  | { phase: "active"; claimId: FileSetClaimId; paths: CanonicalPath[]; owner: ChildContextId; acquiredAt: string }
  | { phase: "checkpointing"; claimId: FileSetClaimId; targetChangeId: ChangeId; jjLockId: string }
  | { phase: "released"; claimId: FileSetClaimId; receipt?: CheckpointReceipt; releasedAt: string }
  | { phase: "interrupted"; claimId: FileSetClaimId; priorPhase: "queued" | "active" | "checkpointing"; reason: string }
  | { phase: "breached"; claimId: FileSetClaimId; reason: string; observedAt: string };
```

Legal transitions:

```text
queued → active
active → checkpointing → released
active → released             (only when no uncheckpointed changes exist)
queued|active|checkpointing → interrupted   (process restart; no ownership survives)
active|checkpointing → breached
```

A queued claim may be cancelled or rerouted before acquisition. It cannot mutate a partial subset. Pre-acquisition content versions are observations, not invariants. The authoritative breach condition is a change by a non-owner during the active critical section. An interrupted owner must acquire a new claim and re-read; old queue position is not restored.

## 5. Isolated workspace writer lifecycle

```ts
type WorkspaceWriterToken =
  | { phase: "available"; workspaceId: WorkspaceId; headChangeId: ChangeId; lastReceipt?: WorkspaceCheckpointReceipt }
  | { phase: "active"; workspaceId: WorkspaceId; owner: ChildContextId; headChangeId: ChangeId }
  | { phase: "checkpointing"; workspaceId: WorkspaceId; owner: ChildContextId; expectedHeadChangeId: ChangeId; operationId: string }
  | { phase: "interrupted"; workspaceId: WorkspaceId; priorOwner: ChildContextId; expectedHeadChangeId: ChangeId };
```

- Only one writable context owns an isolated workspace at a time.
- Acquisition verifies current `@` equals `headChangeId` exactly.
- `workspace_checkpoint` describes that change, creates one fresh empty child, persists `newHeadChangeId`, then releases.
- Restart produces `interrupted`, clears ownership, reconciles any checkpoint receipt, and only then returns to `available`.
- An unreceipted head mismatch stops automatic writes and requires inspection or user-authorized rebind.

## 6. Workspace custody lifecycle

Workspace custody is separate from child execution. A failed context does not imply a disposable workspace.

```ts
type WorkspaceCustody =
  | { phase: "allocating"; allocationId: string; source: SourceIdentity }
  | { phase: "active"; attachment: WorkspaceIdentity; ownerContextId: ChildContextId }
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

Happy and bounded-repair transitions:

```text
allocating → active → reported → acknowledged → reviewing → approved
reviewing → changes_requested → active               (at most one automatic cycle)
reviewing → closed_no_changes
approved → integrating → integrated → verifying → closed
integrating → conflict_resolution → integrated       (after squash and focused review)
closed|closed_no_changes → cleanup_pending            (when only exact cleanup remains)
```

A known crash between integration boundaries may reconstruct the same `integrating` attempt and continue from the next proved idempotent phase. Unknown mutation state transitions to `attention_required`, which has no automatic outgoing transition.

Coupling rules:

- `reported` requires a frozen workspace and captured root/workspace-head/content-tip Change IDs.
- `acknowledged` requires parent event acknowledgement.
- `reviewing` requires no live writer.
- `approved` requires a reviewer receipt accepted by the thinker for normalized patches of exact `root::content-tip` and the expected frozen workspace head.
- Commit-ID-only rewrite does not invalidate approval.
- Patch change requires focused re-review.
- `integrating` requires the repository JJ mutex.
- `conflict_resolution` requires owned unique conflict/squash targets and remaining repair budget.
- `closed` requires product and JJ verification receipts.
- `closed_no_changes` requires an empty-range proof.
- `cleanup_pending` cannot hide semantic or conflict failure.

## 7. Review and mutation receipts

Receipts are immutable evidence, not booleans.

```ts
interface ReviewReceipt {
  workspaceId: WorkspaceId;
  taskPlanSnapshotHash: string;
  sourceWipChangeId: ChangeId;
  rootChangeId: ChangeId;
  contentTipChangeId: ChangeId;
  workspaceHeadChangeId: ChangeId;
  canonicalRevset: string; // exact root::content-tip constructed by code
  orderedChangeIds: ChangeId[];
  normalizedPatchHashes: Record<ChangeId, string>;
  cumulativePatchHash: string;
  findingSummary: FindingSummary;
  reviewedAt: string;
}

interface IntegrationReceipt {
  reviewReceiptId: string;
  operationIds: string[];
  completedBoundaries: IntegrationBoundary[];
  sourceWipChangeId: ChangeId;
  rootChangeId: ChangeId;
  contentTipChangeId: ChangeId;
  workspaceHeadChangeId: ChangeId;
  integratedChangeIds: ChangeId[];
  removedEmptyChangeIds: ChangeId[];
  sourceContentHashBefore: string;
  sourceContentHashAfter: string;
  conflictState: "none" | "resolution_required" | "resolved";
  workspaceState: "present" | "forgotten" | "directory_removed";
  integratedAt: string;
}
```

Source content hashes must match. Commit IDs may change because of clean rebase, description, conflict resolution, or parent rewrite; Change IDs and reviewed normalized patches carry identity.

## 8. Edge-case matrix

| Condition | Disposition | Required action |
|---|---|---|
| Child completes while parent works | Continue | Push bounded custom event at Pi steer boundary |
| Parent has no independent work | Wait | Use token-free `await_child_event` |
| Parent asks for status metadata | Continue | Read coordinator state only |
| Parent needs semantic status | Continue | Request bounded child summary; restore resume point |
| Parent model asks for child history | Stop that access | Request summary instead |
| Root process restarts | Refresh | Clear live queues/locks, recreate resumable contexts, and require reacquisition |
| Child crashes | Recover | Prove mutations quiescent; create linked execution cycle |
| Child is quiet | Continue | Quiet is not a hang; request status after deadline |
| Old writer cannot be proved quiescent | Stop affected writes | Never create duplicate writer |
| Source `@` is nonempty at workspace allocation | Continue | Create from recorded `@-`; do not alter source |
| No WIP exists and `@` is empty | Continue | Deterministically ensure `wip:<task>` |
| No WIP exists and `@` is nonempty | Ask/normalize | Never relabel unknown work silently |
| Source is not JJ / `jj` unavailable | Stop workspace operation | No Git fallback |
| Workspace name/path exists | Refresh or ask | Choose verified unused managed name; never remove unknown content |
| Base commit ID changed | Continue | Ignore; it is not durable identity |
| Base Change ID cleanly rebased | Refresh | Recompute patches/connectivity |
| Root, workspace head, and content tip each resolve exactly once and range is connected | Continue | Use exact inclusive `root::content-tip` |
| A tracked Change ID changed without a receipt | Stop automatic mutation | Inspect; allow explicit user-authorized rebind if replacement is unique and owned |
| Root/head/tip is divergent or unexplained replacement occurred | Stop mutation | Preserve evidence; do not choose a side |
| Commit IDs changed after clean rebase | Refresh | Keep approval if normalized patches are equivalent |
| Patches changed after report | Re-review | Do not integrate stale approval |
| Known deterministic rewrite changed tip evidence | Refresh | Update report/receipt from tool operation |
| Unknown writer changed frozen workspace | Stop workspace writes | Re-establish ownership and review |
| File changes before queued worker acquires set | Refresh | Re-read after acquisition |
| Two file-set requests overlap | Wait | FIFO atomic set queue |
| File changes while owner holds lock | Stop affected writes | Record ownership breach |
| Worker needs additional file | Checkpoint then wait/reroute | Never widen mid-critical-section |
| Shared checkpoint extraction is ambiguous | Reroute/ask | Do not guess fileset or target |
| Planner tries to create workspace | Reject tool call | Nested workspaces are structurally unavailable |
| Planner reports with unresolved/unacknowledged child | Reject report | Preserve descendants |
| Status report arrives | Continue | Persist event; never settle child |
| Status times out | Continue | Return partial metadata |
| Workspace contains unnamed nonempty change | Repair before approval | Semantic owner supplies description; tool applies it |
| Workspace contains safe empty interior changes | Normalize | Remove exact approved interiors; preserve root anchor and active empty workspace head |
| Workspace has expected empty post-checkpoint head | Continue | Exclude it from review range; remove only after recorded workspace forget boundary |
| Workspace range is entirely empty | Continue | `closed_no_changes`; no synthetic commit |
| Stale workspace without recovery | Refresh | Update stale and revalidate |
| Stale update creates recovery history | Stop mutation | Recovery is unowned state |
| Owned rebase conflict has unique targets | Repair | Reviewer→worker→squash→focused review |
| Conflict touches foreign work or ambiguous target | Ask/stop mutation | Do not auto-resolve |
| Reviewer finds goal-blocking drift | Repair once | One implementation cycle and focused re-review |
| Reviewer finds medium/low/out-of-scope issue | Warn/defer | Surface to user and task plan |
| Known integration boundary completed before crash | Resume | Verify receipt and continue next phase |
| Integration phase cannot be reconstructed | Stop mutation | Preserve JJ operation evidence |
| Directory cleanup fails after verified integration | Warn | Mark `cleanup_pending`; semantic result may remain closed |
| Verification finds requested behavior wrong | Repair/ask | Apply severity and loop budget |
| Verification check is flaky/unrelated | Retry boundedly/warn | Do not rewrite reviewed work automatically |
| Private selector missing | Warn | Explain recommended config; do not edit it |
| WIP is immutable | Stop WIP mutation | Read-only work may continue; never ignore immutability automatically |
| User asks to publish | Outside subsystem | Require separate authorized workflow |
| Usage telemetry is partially missing | Warn | Preserve work; report unattributed amount |
| Managed cleanup path escapes or is symlinked | Stop cleanup | Never follow outside managed root |

## 9. User interface invariants

- `/subagents list` and `/subagents inspect` are full-width inline panes, not persistent status widgets.
- Viewports show 6–16 content rows and are keyboard-scrollable.
- Navigation supports arrows, Page Up/Down, Home/End, lowercase `g`, uppercase `G`, and Escape.
- Trees use `├──`, `└──`, and `│` from durable hierarchy.
- Active and live-await views hide terminal descendants.
- Inactive and inspect retain terminal summaries, lifecycle events, review findings, workspace state, and usage.
- The UI does not expose a command to enter a child context.
- Parent model context never receives inspect details or transcripts.
- Objective and selector rows truncate with `…` and never wrap.
- An await view is observational; it never changes child lifecycle.

## 10. Invalid combinations the implementation must eliminate

- terminal execution without a bounded report;
- multiple terminal reports for one execution cycle;
- terminal report acknowledged more than once;
- status report treated as terminal;
- replacement writer active before prior writer quiesces;
- shared source mutation without an active covering file-set claim;
- partial multi-file lock grant;
- released lock with uncheckpointed owned changes;
- shared checkpoint into a Change ID not assigned to that context;
- isolated workspace write without the workspace-wide token;
- `workspace_checkpoint` releasing the token before persisting the new exact head Change ID;
- reviewer with write or workspace-integration authority;
- reported workspace without frozen root/workspace-head/content-tip boundaries;
- approved workspace without task-plan, exact workspace-head, and normalized-patch receipt;
- approval invalidated solely by commit-ID changes;
- integrated workspace without review receipt;
- conflict marked resolved without squash and focused-review receipts;
- closed workspace without verification;
- `closed_no_changes` with retained nonempty changes;
- `cleanup_pending` used to hide semantic/integration failure;
- `attention_required` without last-safe boundary and evidence;
- child transcript inserted into parent model context;
- child usage counted in both intrinsic and ancestor totals;
- execution cancellation implicitly deleting workspace custody.

Boundary DTOs may remain migration-tolerant, but conversion into the internal model must reject or quarantine these combinations.
