# ADR 0006: Target the ACP v2 draft before implementing the shim

## Status

Accepted.

## Context

Pi-Tai has Host, runtime-worker, and internal protocol proofs, but no ACP shim implementation. ACP v2 is now available as a draft and changes several assumptions that would otherwise become embedded in the broker and adapter:

- `session/prompt` acknowledges acceptance instead of owning a turn;
- `state_update` reports `running`, `requires_action`, and `idle` independently of request completion;
- `session/update` may arrive while the session is idle;
- messages, tool calls, terminals, and plans use stable domain-specific IDs and upsert/chunk semantics;
- `session/resume` with `replayFrom` replaces `session/load`;
- advertising `capabilities.session` commits the Agent to the complete baseline session method set;
- plans use `plan_update` with a stable `planId`;
- diffs use structured file operations and optional Git patch text;
- Agent-owned terminals replace the v1 Client execution surface;
- config options replace dedicated mode APIs;
- enum-like values and tagged unions are open for future and `_`-prefixed implementation variants.

Building the product model around v1 first would introduce turn ownership, replay, tool, plan, and terminal assumptions that would immediately need replacement. This is a personal, pre-production project, so early draft churn is less costly than a deliberate v1-first migration.

## Decision

Pi-Tai will implement an **ACP v2 draft-first, v2-only initial shim**.

The first proof pins the exact official TypeScript SDK and schema revision. The current research baseline is:

- `@agentclientprotocol/sdk@1.3.0` via `@agentclientprotocol/sdk/experimental/v2`;
- ACP schema release `schema-v2.0.0-alpha.2`.

The implementation may move to a newer matched SDK/schema pair before H5 begins, but the selected versions, schema checksum, and upstream source revision must be recorded in fixtures and locked exactly. Until the protocol stabilizes, the proof shim requires `--experimental-acp-v2` (or `PI_TAI_ACP_V2_DRAFT=1` in automated harnesses) in addition to normal protocol-version negotiation.

The first shim will not implement ACP v1 fallback. A peer requesting v1 receives normal ACP version negotiation toward v2 and may close the connection. If real Zed acceptance remains blocked after its v2 client ships or if a temporary v1 bridge becomes necessary, that bridge must be a separate wire adapter translating into the same v2-shaped product model; it must not reintroduce v1 semantics into broker state.

The Host remains the source of truth for durable session items and their stable IDs. The disposable shim does not invent replay identities or reconstruct canonical history.

The broker models these facts independently:

- whether ACP resources are attached/active;
- foreground work as `Idle`, `Running`, or `RequiresAction`;
- runtime health and load state;
- an append-only stream of session item updates that may continue in any foreground state.

Only one foreground Pi operation is accepted at a time for the initial implementation, but updates are never scoped to the lifetime of the `session/prompt` JSON-RPC request.

At the ACP boundary, omitted, `null`, and concrete patch values are represented explicitly. Wire DTOs use a three-state patch type rather than collapsing omission and clear into `Option`. Canonical product projections store validated state; replay can emit complete replacement snapshots where that is simpler and less ambiguous.

## Consequences

### Positive

- No throwaway v1 session lifecycle, load path, plan shape, diff shape, or terminal model.
- Host-owned durable replay naturally supports agent-owned message IDs and multi-client observation.
- Background updates and future queueing do not require another broker redesign.
- Draft changes are concentrated in the ACP package, fixture mapping, and explicit wire/domain conversions.
- The product model remains useful for desktop/mobile clients without exposing raw ACP.

### Negative

- Stock Zed compatibility depends on a Zed build that can negotiate ACP v2.
- The official SDK import and generated schema are explicitly experimental and may change incompatibly.
- A schema bump may require fixture and adapter changes before any product feature work can continue.
- There is no v1 fallback for existing ACP clients in the initial alpha.

## Guardrails

- Never use ACP generated structs as broker persistence records or product API DTOs.
- Never infer session completion from the `session/prompt` response.
- Never scope `session/update` acceptance to an active prompt request.
- Generate and persist message, tool-call, terminal, plan, permission, and foreground-operation IDs before exposing them through ACP.
- Reject malformed known variants; preserve unknown variants only at boundaries where forwarding or safe fallback is actually supported.
- Advertise only complete end-to-end capabilities.
- `session/close` is an explicit operation that cancels foreground work and releases the ACP activation; process disconnect is only a detach and does not cancel Host-owned work.
- Keep independently authored ACP v2 fixtures for lifecycle, replay, patch clearing, cancellation, permissions, plans, tools, terminals, diffs, config, and JSON-RPC batches.
