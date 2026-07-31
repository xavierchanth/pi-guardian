# I19 — Configuration ownership and feature policy

**Status:** Planned  
**Depends on:** I01, I02, I03

## Outcome

Configuration has one explicit owner. Terminal/client preferences remain local to the client; session and machine policy is resolved and authenticated by the Host, pinned to the session, and passed to the runtime. `core` denotes shared TypeScript behavior beneath the worker, not Host ownership.

## Inventory and classification

Before migration, inventory every configuration field, default constant, environment variable, registrar, and provenance entry. Classify each as:

- terminal/client preference (rendering and local interaction),
- Host-owned session policy,
- Host-owned machine policy/capability, or
- a justified, documented opt-out.

The audit explicitly covers subagents and allowed test harnesses, context transfer and retention, keybinding provisioning, model-profile cycling, ANSI polling, native notifications, `/btw`, footer, and response editor. Existing compaction and cmux opt-outs remain preserved unless separately approved.

## Security invariants

Guardian policy is not a preference. High/critical blocking, project-policy non-widening, canonical path boundaries, and deterministic destructive-action rules remain non-configurable. Future task-aware Guardian evidence must be authenticated Host task evidence; conversation text is not equivalent task authority. Existing action/arguments, cwd, canonical path and destructive evidence, conversation, reviewer, and deterministic rules remain intact during that addition.

## Checkpoints

1. Publish the field/constant/environment/registrar inventory with current and intended owners.
2. Define typed terminal preference, session policy, and machine policy boundaries.
3. Move policy resolution and provenance to Host session creation/opening.
4. Pass immutable resolved policy through the runtime protocol; prevent runtime widening.
5. Record each opt-out with owner, reason, test coverage, and deletion/review trigger.
6. Add architecture tests preventing clients or terminal adapters from becoming policy authorities.
7. Add authenticated Host task evidence to Guardian without weakening existing outcomes.
8. Update repository, architecture, settings, and package readmes as each ownership move lands.

## Exit criteria

- Every configurable value has one documented owner and provenance path.
- Terminal preferences cannot widen Host session or machine policy.
- All opt-outs are explicit and tested, including preserved compaction/cmux exceptions.
- Guardian's non-configurable boundaries and policy outcomes are regression-tested.
- Current architecture, repository, settings, and readme documentation agree.
