# M2 shared-source concurrency implementation plan

Status: implementation in progress.

This plan implements slices C0–C3 from the accepted [implementation DAG](IMPLEMENTATION_DAG.md). It uses the M0 semantic JJ boundary and Real-JJ fixture and integrates with the M1 root-scoped private child runtime.

## Scope

M2 delivers one safe shared-source path:

```text
inspect/ensure source WIP
→ insert a named target before the same WIP
→ bind that target to one writer context
→ acquire the writer's complete canonical file set
→ re-read and edit through guarded source tools
→ validate while the claim remains active
→ checkpoint only that set into the assigned target
→ verify and persist the receipt
→ release the set
```

M2 does not allocate isolated workspaces, review ranges, integrate workspace ranges, or remove the legacy subprocess compatibility path. Those remain M3–M5 work.

## Accepted implementation decisions

1. **One repository kernel per process.** Repository mutation mutexes are shared across root coordinators in the process, while source handles, claims, and receipts remain root/session attributable.
2. **Opaque model boundary.** Model-visible JJ mutation tools never accept cwd, revsets, JJ argv, source/WIP/target Change IDs, or operation IDs. `acquire_file_set` accepts repository-relative paths because choosing the complete semantic write scope is model intent.
3. **Durable source state.** A versioned atomic side store records source identity, WIP identity, inserted target ownership, claim transitions, mutation attempts, and completed receipts. Commit IDs remain diagnostic only.
4. **Exact identity.** Every managed Change ID lookup is constructed internally as `exactly(change_id(<full-id>), 1)`.
5. **FIFO complete-set claims.** Equal and ancestor/descendant paths overlap. A request is granted atomically only when it conflicts with neither an active claim nor an earlier overlapping waiter.
6. **Restart drops authority.** Persisted queued, active, or checkpointing claims become interrupted when loaded into a new coordinator. Queue position and live ownership are never restored.
7. **Source-tool guard.** Shared workers cannot call `write` or `edit` without a covering active claim. Successful guarded mutations refresh the claim's owned fingerprints. Shell validation remains available, but direct shell/JJ source mutation is blocked or detected as a claim breach before checkpoint.
8. **WIP normalization.** An existing recorded WIP is verified. An empty current change may be described canonically. Unknown nonempty work returns `decision_required`; Pi-Tai never relabels it silently or bypasses immutability.
9. **Insertion preserves source.** `insert_change` creates a named empty parent immediately before the recorded WIP with `jj new --no-edit --insert-before …`; it verifies WIP identity and content evidence before persisting owner binding.
10. **Checkpoint keeps the WIP.** `checkpoint_change` uses an internally constructed literal fileset and `--keep-emptied`, verifies unrelated WIP evidence, target ownership, conflict state, exact parentage, and receipt durability, then releases. Failure retains or breaches the claim for diagnosis.
11. **Conservative partial-mutation recovery.** A completed independently verified postcondition is receipted; a provably unchanged precondition is safe to reissue; all other interrupted mutations become `unknown_partial_mutation` and stop affected writes.
12. **No configuration mutation/publication.** Production inherits repository/user identity, signing, immutability, and private-change policy. M2 only diagnoses private protection and never edits config, creates bookmarks, fetches, or pushes.

## Slice DAG

```text
C0.0 durable source/attempt/receipt state
  └─ C0.1 repository mutex and exact resolver
       ├─ C1.0 canonical FIFO file-set coordinator
       │    └─ C1.1 shared source-tool guards
       └─ C2.0 status and ensure_wip_change
            └─ C2.1 insert_change and owner binding
                  └─ C3.0 checkpoint_change and interruption classifier
                       └─ C3.1 model tools, role policy, and end-to-end acceptance
```

## Slice contracts

### C0.0 — durable shared-source state

Add strict DTOs and atomic persistence for source identity, WIP tracking, inserted targets, file-set claims, operation attempts, and receipts. Parse once at the storage boundary and keep impossible phase/field combinations out of the internal domain.

**Tests:** round trip, invalid-state quarantine, atomic update serialization, traversal-safe paths, and restart interruption.

**Checkpoint:** `refactor(jj): add shared source persistence`

### C0.1 — repository kernel

Add repository-scoped mutation serialization, exact Change-ID resolution, long-form command construction, operation-ID capture, normalized content/patch evidence, and structured executor failure classification.

**Tests:** scripted executor argv contracts, exact-one failures, mutex serialization, and no short options/config mutation.

**Checkpoint:** `feat(jj): add deterministic repository kernel`

### C1.0 — file-set coordinator

Canonicalize repository-relative paths through existing real paths or the nearest existing ancestor. Implement complete-set FIFO acquisition, ancestor/descendant overlap, cancellation, release verification, owner mutation fingerprints, breach state, and restart interruption.

**Tests:** disjoint parallel grants, exact/ancestor overlap FIFO, atomic multi-file sets, cancellation, pre-lock refresh, in-lock breach, and no unchecked release.

**Checkpoint:** `feat(concurrency): add shared file-set coordinator`

### C1.1 — source-tool guards

Bind shared child contexts to inserted targets. Guard built-in `write`/`edit` before mutation, refresh owned fingerprints after successful execution, and constrain shared-worker shell/JJ mutation while preserving bounded validation commands.

**Tests:** uncovered and wrong-owner denial, covered mutation success, scope widening denial, shell mutation denial, and validation allowance.

**Checkpoint:** `feat(subagents): guard shared source mutations`

### C2.0 — status and WIP readiness

Implement `jj_concurrency_status` and `ensure_wip_change` over the injected source handle. Report current identity, description, emptiness, conflicts, mutability, parent observations, private-selector diagnostics, claims, and recovery blockers.

**Real-JJ tests:** empty unnamed WIP, existing recorded WIP, nonempty unknown decision, immutable blocker, exact identity, and missing private-selector warning without configuration changes.

**Checkpoint:** `feat(jj): ensure shared source wip`

### C2.1 — inserted target allocation

Implement thinker-only `insert_change`. Validate the direct child owner, preserve WIP Change ID/content evidence, insert one named empty target before WIP, capture parent transitions and operation ID, and persist the assignment before messaging the worker.

**Real-JJ tests:** insertion topology, identity/content preservation, owner binding, deterministic multiple insertion order, divergence stop, and crash boundaries.

**Checkpoint:** `feat(jj): insert assigned shared changes`

### C3.0 — deterministic shared checkpoint

Implement `checkpoint_change` over the caller's injected active claim. Move only locked paths from WIP into the assigned target, preserve unrelated WIP evidence and identity, detect conflicts/breaches, persist a verified receipt, and release only after persistence.

**Real-JJ tests:** one-path extraction, unrelated WIP preservation, unlocked/wrong target rejection, all-path WIP extraction while retaining WIP identity, interrupted phase classification, and two contending writers producing `edit→checkpoint→edit→checkpoint`.

**Checkpoint:** `feat(jj): checkpoint locked shared changes`

### C3.1 — production tool cutover

Register bounded tool schemas, inject source/target/claim handles from runtime state, update thinker/worker definitions and task instructions, expose bounded status, and retain compatibility with existing child runtime tools.

**Tests:** model schemas omit private mutation values; role authority is exact; private child factories resolve the new tools; one model-free production harness executes the complete shared path.

**Checkpoint:** `feat(subagents): expose shared jj concurrency tools`

## M2 exit gates

M2 is complete only when:

1. every managed Change ID lookup uses exact full Change-ID resolution;
2. source WIP normalization never relabels unknown nonempty work;
3. inserted targets preserve source WIP identity and content;
4. overlapping complete file sets serialize FIFO and cannot partially grant;
5. shared child file mutation without a covering claim is blocked;
6. checkpoint moves only the active claim's paths into its assigned target;
7. unrelated WIP evidence and WIP Change ID are preserved;
8. claims remain held through verified durable checkpoint receipts;
9. restart interrupts claims and does not restore live authority or queue position;
10. deterministic Real-JJ tests prove single-writer and contended histories;
11. typecheck, full tests, isolated package smoke, docs links, and diff checks pass.
