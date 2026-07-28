# I06 — Shared-source JJ concurrency

**Status:** Complete  
**Depends on:** I05

## Outcome

Bounded workers safely edit a shared source workspace through atomic whole-file ownership and deterministic feature checkpoints while preserving the orchestrator's private WIP change.

The complete supported path is:

```text
inspect or ensure source WIP
→ insert a named owner-bound target before the same WIP
→ acquire the writer's complete canonical file set
→ re-read and edit through guarded source tools
→ validate while the claim remains active
→ checkpoint only claimed paths into the assigned target
→ verify and persist receipt
→ release the claim
```

## Delivered

### Durable shared-source state

- Versioned atomic source identity, WIP identity, inserted-target ownership, claim transitions, mutation attempts, and receipts.
- Strict phase validation and quarantine of invalid persisted combinations.
- Restart converts queued, active, and checkpointing claims to interrupted evidence; live authority and queue position are never restored.
- Existing canonical WIP state can be adopted only after strict safe validation.

### Repository kernel

- One repository mutation kernel/mutex per process, shared across root coordinators.
- Root/session attribution retained for source handles, claims, attempts, and receipts.
- Opaque source handles and internally constructed exact Change-ID resolution.
- Every managed Change ID lookup uses `exactly(change_id(<full-id>), 1)`.
- Long-form JJ command construction, operation IDs, normalized evidence, and structured failure classification.
- Production inherits identity, signing, immutability, and private-change policy and never edits configuration or publishes.

### Atomic file-set coordination

- Repository-relative model input expresses the complete semantic write scope; cwd and private identities remain injected.
- Paths canonicalize through an existing path or nearest existing ancestor.
- Equal and ancestor/descendant paths overlap.
- A complete set grants only when it conflicts with neither an active claim nor an earlier overlapping waiter.
- Disjoint claims may proceed concurrently.
- Cancellation, release verification, owned fingerprints, breach state, and restart interruption are durable.

### Guarded shared writes

- Shared workers cannot use built-in `write` or `edit` without a covering active claim.
- Successful guarded writes refresh claim-owned fingerprints.
- Scope widening without a new complete claim is denied.
- Conservative shell policy permits bounded reads/validation while denying direct source and managed-JJ mutation.
- A source mutation bypass is detected as a claim breach before checkpoint.

### WIP and feature target operations

- `jj_concurrency_status` exposes bounded source, WIP, claim, mutability, conflict, private-selector, and recovery evidence.
- `ensure_wip_change` verifies recorded WIP, canonically describes a safe empty current change, and returns `decision_required` for unknown nonempty work.
- `insert_change` creates a named empty owner-bound parent immediately before preserved WIP and persists assignment before worker messaging.
- WIP identity and content evidence are verified before and after insertion.

### Deterministic checkpoint

- `checkpoint_change` consumes the caller's injected active claim and assigned target.
- Only claimed literal paths move from WIP into the assigned target.
- WIP identity remains present even when all current paths move to the target.
- Unrelated WIP evidence, target ownership, exact parentage, and conflict state are verified.
- Receipt becomes durable before claim release.
- Failure retains or breaches the claim for diagnosis.
- Interrupted mutation is classified as independently complete, provably unchanged/safe to reissue, or `unknown_partial_mutation`.

### Production cutover and proof

- Bounded model tools, orchestrator/worker role policy, task instructions, source-tool guards, and runtime reconciliation use the shared path.
- Model schemas omit cwd, revsets, JJ argv, WIP/target Change IDs, and operation IDs.
- Real-JJ tests prove one-path extraction, unrelated WIP preservation, wrong-scope/owner denial, all-path extraction, interruption classification, and two contending writers producing `edit→checkpoint→edit→checkpoint`.
- Typecheck, full test suites, isolated package smoke, documentation links, and diff checks passed at milestone completion.

## Implemented checkpoints

- `poyxwnpymmyr` — durable shared-source state, claims, attempts, and receipts;
- `nkzktyqplpvo` — repository mutex, opaque handles, exact resolver, and operation kernel;
- `ylnttmrszssn` — canonical FIFO file-set coordinator and recovery evidence;
- `nqpvkskwrxsn` — source-tool and constrained-shell guards;
- `yrxvvzzrnuow` — WIP readiness and owner-bound target allocation;
- `xustxxumtnwk` — locked-path checkpointing and Real-JJ contention/recovery proof;
- `uvnsmlkyxrqo` — production tools, role policy, prompts, and runtime reconciliation;
- `puyonsxqostr` — strict phase validation and safe canonical-WIP adoption.

## Boundary of completion

I06 does not provide isolated workspace writer leases, exact frozen review ranges, reviewer approval, workspace integration, or final legacy subprocess removal. Those remain I07–I09.

## Superseded

The WIP-label invariants delivered here — `ensure_wip_change`, the `wip:`/`private:` description requirement on source `@`, canonical-WIP adoption, and the `decision_required`/`foreign_work` blockers that defend the label — are superseded by **I14**, which makes source `@` the user's and anchors the shared lane on `@-` instead. Every other invariant above (claims, guarded writes, checkpoints, receipts, restart interruption) is preserved unchanged.
