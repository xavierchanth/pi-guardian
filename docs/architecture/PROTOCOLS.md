# Protocol boundaries

## Principle

Pi-Tai has two distinct wire boundaries and one canonical product model:

```text
clients ⇄ Host protocol ⇄ Host session domain ⇄ runtime protocol ⇄ Pi runtime/core
             │                    │
             └── ACP adapter      └── canonical persistence
```

Neither Host-client nor Host-runtime DTOs are persisted directly. Every boundary converts explicitly to validated semantic commands/events.

## Host client protocol

The Host client contract is transport-neutral even when initially carried over local IPC.

### Baseline

- protocol and implementation version negotiation;
- client/Host identity and authentication;
- session create/list/get/attach/close;
- optional cursor replay and live event stream;
- prompt acceptance, cancellation, interactions, and steering;
- model/config/capability discovery;
- stable semantic IDs and operation idempotency;
- expected revision conflicts;
- bounded structured errors.

### Patch semantics

Where a client protocol permits patches, converters distinguish:

```ts
type Patch<T> =
  | { kind: "missing" }
  | { kind: "clear" }
  | { kind: "set"; value: T }
  | { kind: "append"; value: T };
```

Optional/nullable fields alone cannot safely represent leave-unchanged versus clear. Canonical replay may emit full replacements rather than recreating obsolete chunk boundaries.

## Runtime protocol

The Host-runtime contract controls a supervised worker generation.

Host commands include:

- initialize and report capabilities;
- create/load/unload root runtime context;
- submit accepted prompt or interaction;
- steer/cancel;
- reconcile and report quiescence;
- request bounded state/health;
- shut down.

Worker events include:

- initialization/health/generation;
- canonicalizable message/tool/work-context/usage events;
- child/concurrency lifecycle events;
- operation receipt/artifact references;
- settled/interrupted/failed state;
- quiescence evidence.

The protocol must preserve correlation and ordering but does not assign Host session revisions independently.

## ACP adapter

ACP is an external client protocol, not Pi-Tai's product model.

Initial semantics:

- use one exact negotiated ACP v2 baseline;
- advertise a capability only when the complete editor→shim→Host→runtime path works;
- implement session new/list/resume/close/prompt/cancel/update as one coherent baseline;
- respond to prompt after durable acceptance, then represent running/requires-action/idle through updates;
- permit background updates while idle;
- preserve Host item IDs across live delivery and replay;
- treat process disconnect as detach and explicit close as product close/cancel behavior;
- keep shim stateless and disposable;
- isolate draft schema churn in adapter/fixtures unless product semantics change.

Stable Host events map to ACP message, tool-call, terminal, plan, session-info, usage, configuration, and interaction updates. Unsupported inbound variants are rejected despite syntactically open unions; negotiated capability remains authoritative.

## Replay barrier

All streaming client adapters implement:

1. attach and select durable high-water mark;
2. buffer later live events;
3. emit canonical history through mark;
4. complete attach/resume response at the protocol-defined point;
5. release buffered events after the mark without duplication;
6. continue live stream.

## Compatibility and generation

- Rust/TypeScript bindings have one declared source of truth and a check mode.
- Fixtures are independently understandable JSON, not only generated structs.
- Unknown future variants are preserved only at audited extensible boundaries with safe fallback.
- Known discriminators validate strictly.
- Protocol upgrade does not silently migrate canonical persistence.
- Version mismatch fails before stateful commands.
- Stdout of stdio protocols remains protocol-only.

## Security

- Authentication precedes attachment and command processing.
- Credentials never appear in URLs, process arguments, or normal event payloads.
- Frames, item counts, and artifacts are bounded.
- Remote transport adds authenticated encryption and product-level device authorization.
- Protocol access does not imply permission to invoke every Host capability.
