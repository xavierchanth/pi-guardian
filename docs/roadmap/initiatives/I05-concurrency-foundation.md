# I05 — Concurrency runtime foundation

**Status:** Complete  
**Depends on:** none

## Outcome

Strict concurrency/JJ foundations and private in-process child execution exist, allowing subsequent shared and isolated JJ work to build on stable runtime semantics.

## Delivered

### Foundation

- semantic IDs and strict lifecycle unions;
- semantic JJ capability and structured process-executor boundaries;
- Real-JJ fixture with independent snapshots/assertions;
- private concurrent Pi SDK child feasibility;
- opt-in concurrency eval runner.

### In-process child runtime

- versioned child context persistence and private journals;
- private child SDK session factory;
- root-scoped child coordinator;
- all new launches routed in-process;
- hidden typed push events and explicit acknowledgement;
- interruptible event waits and bounded status/summary requests;
- authoritative usage ledger and journal retention;
- post-order reconciliation and quiet continuation;
- compatibility projection for legacy records.

## Remaining compatibility debt

- old subprocess/FIFO launcher for legacy recovery;
- legacy aliases and transcript-era projections;
- persistence coupling between new concurrency and old subagent modules;
- downstream JJ receipt classifiers supplied by later initiatives.

These are removed by I09 after I06–I08 provide production parity.

## Acceptance preserved

- no user-role protocol impersonation;
- no child-history projection;
- user input interrupts only active await;
- root abort does not cancel children;
- terminal events require acknowledgement;
- separate roots remain isolated;
- replacement writers require quiescence;
- usage is counted once;
- clean closure and incident retention follow explicit journal policy.
