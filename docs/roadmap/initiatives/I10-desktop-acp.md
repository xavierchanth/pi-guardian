# I10 — Desktop and ACP clients

**Status:** In progress  
**Depends on:** I04

## Existing foundation

The repository contains a Tauri/React Host UI proof, ACP v2 adapter code and fixtures, TypeScript Host client/protocol packages, Rust Host server tests, and continuity scenarios. These prove interfaces but must converge on the common client contract.

## Outcome

Desktop manages the Host and sessions; ACP is a thin editor adapter. Both consume canonical Host commands/events and own no durable session state.

## Desktop scope

- Host installation/startup/version/health;
- model/authentication readiness;
- machine capability and client-pairing state;
- session list/status and diagnostics;
- safe restart and launch-at-login behavior;
- later full session presentation over the same event stream.

## ACP scope

- exact negotiated ACP v2 baseline;
- new/list/resume/close/prompt/cancel/update;
- durable prompt acceptance separate from completion;
- stable item/tool/terminal/plan IDs;
- duplicate-free replay barrier;
- explicit wire missing/clear/set/append conversion;
- disconnect detach versus explicit close semantics;
- no database, Pi process, or durable state in shim.

## Exit criteria

- Desktop closure leaves Host running.
- ACP process termination leaves healthy Host session running.
- Both clients display the same canonical session facts.
- Protocol draft churn remains isolated to adapter/fixtures unless semantics change.
- Generated frontend output is release-built rather than accidental source state.
