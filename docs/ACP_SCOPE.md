# Pi-Tai ACP v2 Scope

## Status and protocol decision

Stage 2 design targets the ACP v2 draft before any ACP shim exists. The decision and compatibility consequences are recorded in [ADR 0006](adr/0006-target-acp-v2-draft.md).

Pi-Tai ACP is a product-owned thin Agent implementation built on the official TypeScript SDK's experimental v2 entry point. The current research baseline is `@agentclientprotocol/sdk@1.3.0` with schema release `schema-v2.0.0-alpha.2`; H5 must pin a matched SDK/schema pair, checksum, and upstream revision exactly before implementation.

The initial shim is v2-only. It does not carry a v1 protocol surface or `session/load` compatibility path. The proof binary requires `--experimental-acp-v2` (or `PI_TAI_ACP_V2_DRAFT=1` in automated harnesses) and still negotiates protocol version 2. If a v1 bridge is later required, it must be an isolated adapter over the same v2-shaped Host model.

The ACP process does not own Pi sessions. It connects Zed to the separately running Pi-Tai Host Agent over authenticated local IPC. The Host supervises a bundled TypeScript helper that loads Pi through its SDK in-process. See [HOST_ARCHITECTURE.md](HOST_ARCHITECTURE.md).

## ACP v2 contract baseline

Advertising `capabilities.session` commits Pi-Tai to all baseline methods:

- `session/new`;
- `session/list`;
- `session/resume`;
- `session/close`;
- `session/prompt`;
- `session/cancel`;
- outbound `session/update`.

The initial capability response advertises no partial baseline. Text and resource links are baseline prompt content. Image support, embedded resources, additional directories, session deletion, and MCP transports are advertised only after their complete Zed → shim → Host → Pi path passes fixtures and integration tests.

ACP v2 lifecycle rules control the design:

1. `session/prompt` ends when the Host durably accepts or rejects the prompt, not when Pi finishes foreground work.
2. On acceptance, the shim queues the empty prompt response before releasing related updates, then emits the Host-authored `user_message` and `state_update: running`.
3. Completion is an idle `state_update` with a stop reason. The prompt response never carries completion.
4. `session/update` may arrive while idle; neither the shim nor Host drops an event because no prompt request is pending.
5. The initial product rejects a second prompt while foreground Pi work is not idle. Queueing can be added later without changing request ownership.
6. `session/cancel` has no ACP turn ID. The Host resolves it against the current durable foreground-operation ID and confirms completion with idle/cancelled state.
7. An ACP process disconnect only detaches. Explicit `session/close` cancels foreground work, resolves pending permissions as cancelled, and releases the ACP activation as v2 requires.
8. `session/resume` without `replayFrom` reattaches without history. `{ "type": "start" }` replays complete history before the response. There is no `session/load`.

## Product model required by v2

The Host stores one authoritative representation of each fact rather than persisting ACP generated types.

### Orthogonal session state

The session actor models these independently:

- **activation/attachments:** which clients are attached and whether an ACP session activation is open;
- **foreground work:** `Idle { last_stop_reason? }`, `Running { operation_id }`, or `RequiresAction { operation_id, interaction_id }`;
- **runtime health:** unloaded, starting, ready, interrupted, or failed;
- **session item stream:** durable updates that may be appended in any foreground state.

Only one `Running` or `RequiresAction` foreground operation exists at a time initially. Background updates do not imply running foreground work. A session is not globally “completed”; completion is a transition of one foreground operation back to idle.

Actor transitions and persistence validation enforce:

- `Idle` carries no active operation or interaction ID;
- `Running` carries one existing foreground-operation ID and no pending action;
- `RequiresAction` carries the same existing operation ID plus one unresolved interaction owned by it;
- accepting a prompt requires an ACP activation and `Idle` foreground state;
- runtime interruption atomically resolves pending interaction state, changes non-idle foreground work to `Idle` with custom stop reason `_pi_tai_interrupted`, and marks runtime health interrupted;
- unloaded or failed runtime health cannot coexist with non-idle foreground work after a transaction commits;
- zero client attachments may coexist with `Running` because disconnect is not cancellation;
- session-item updates are valid in every foreground state.

Database constraints protect ID uniqueness and referential ownership; actor command methods enforce cross-field transitions. Corrupt snapshots are rejected and rebuilt from validated events rather than admitted as a new state.

### Stable identity and replay

The Host generates and persists semantic IDs before events are exposed:

- message ID;
- tool-call ID;
- terminal ID;
- plan ID;
- permission/interaction ID;
- foreground-operation ID.

The disposable shim must not derive IDs from JSON-RPC request IDs, worker command IDs, array positions, or replay order. Live and replayed forms of one item use the same ID.

Normalized event families include message upsert/chunk, tool-call patch/content chunk, terminal patch/output bytes, plan replacement, foreground state change, config replacement, session-info patch, usage replacement, and interaction lifecycle. Pi and ACP payloads may be retained as redacted diagnostics but are not canonical product state.

### Patch and extension semantics

ACP message, tool-call, terminal, and metadata updates distinguish:

- omitted: leave unchanged;
- `null`: clear;
- concrete value: replace;
- chunk update: append according to the specific item contract.

Wire DTOs must use an explicit `Missing | Clear | Set<T>` representation at conversion points. A single optional/nullable field is not sufficient. Canonical projections may emit full replacement snapshots during replay to avoid reproducing obsolete chunk boundaries.

Known discriminator values are validated strictly. Unknown future or `_`-prefixed variants are preserved only where Pi-Tai stores, replays, or forwards them and has a safe generic fallback. Unsupported inbound prompt variants are rejected even if syntactically open; capability negotiation remains authoritative. Custom fields use `_meta` or `_`-prefixed methods/variants, never new root fields.

### Replay barrier

For `session/resume` with replay from start, the Host supplies a replay high-water mark. The shim:

1. attaches and begins buffering live events after the mark;
2. emits canonical history through the mark in sequence order;
3. queues the resume response after the requested history has been sent;
4. releases buffered later events after the response is queued, then continues live delivery without duplication.

Replay uses terminal output snapshots, complete plans, and complete item replacements where possible. It never invents a synthetic end-turn response.

## Priority legend

- **P0:** required for the first useful ACP v2/Zed alpha.
- **P1:** important follow-up for daily use.
- **P2:** evaluate after the alpha.
- **Out:** excluded or unavailable in ACP v2.

All optional and unstable features are guarded by negotiated capabilities in addition to the top-level draft enablement.

## Feature matrix

| Area | Feature | Priority | Notes |
|---|---|---:|---|
| Protocol | JSON-RPC 2.0 over newline-delimited stdio | P0 | Use the official SDK; stdout is protocol-only. |
| Protocol | Single and batch JSON-RPC messages | P0 | Lifecycle-sensitive calls are not emitted in batches. |
| Protocol | Version/capability negotiation and required `info` | P0 | Initial shim negotiates v2 only. |
| Protocol | Structured errors, cancellation, and graceful shutdown | P0 | Broken pipe detaches without cancelling Host work. |
| Protocol | Open enum/union parsing and `_meta` | P0 | Preserve only at audited boundaries with safe fallback. |
| Session | New, list, resume, close | P0 | Complete ACP v2 session baseline. |
| Session | Resume without replay | P0 | Omitted/null `replayFrom`. |
| Session | Resume with full replay | P0 | `replayFrom: { type: "start" }`; replaces v1 load. |
| Session | Prompt acceptance and cancellation | P0 | Prompt responds immediately after durable acceptance; idle update completes work. |
| Session | Cursor pagination and cwd filtering | P0 | `session/list` is baseline and must remain bounded. |
| Session | Additional workspace directories | P1 | Advertise `session.additionalDirectories` only end to end. |
| Session | Delete session | P1 | Optional `session.delete`; idempotent list removal. |
| Session | Fork session | P2 | Only if a future v2 extension stabilizes and Zed uses it. |
| Prompt | Text and resource links | P0 | ACP v2 baseline. |
| Prompt | Images | P0 | Advertise `session.prompt.image` after Pi translation passes. |
| Prompt | Embedded resources | P1 | Advertise `session.prompt.embeddedContext`. |
| Prompt | Audio | Out | Not needed. |
| Prompt | Steering, follow-ups, and queueing | P1 | Product commands first; never overload prompt-request lifetime. |
| Output | User message acknowledgement | P0 | Host-generated stable message ID and canonical accepted content. |
| Output | Streaming assistant text | P0 | Stable message ID; chunks append. |
| Output | Whole-message replacement/clear | P0 | Exercise omitted/null/value semantics. |
| Output | Separate thought stream | P1 | Only when presentation and disclosure policy are acceptable. |
| Output | Background updates while idle | P0 | Core v2 lifecycle requirement. |
| Output | Retry and compaction status | P1 | Keep concise and state-accurate. |
| Tools | `tool_call_update` upsert lifecycle | P0 | No v1 `tool_call` create variant. |
| Tools | Human-readable titles, semantic kinds, status, locations | P0 | Preserve parallel identity. |
| Tools | Raw input/output content | P0 | Replace snapshots or append complete content chunks. |
| Tools | Structured v2 diffs | P0 | Authoritative add/delete/modify/move/copy changes plus optional `git_patch`. |
| Tools | Agent-owned display terminal | P0 | Stable terminal ID, base64 byte chunks, snapshots, and exit status. |
| Tools | Translation/renderer registry | P1 | Allow custom Pi-Tai tools to add semantics. |
| Plans | Item `plan_update` with stable plan ID | P0 | Complete replacement entries; no v1 `plan`. |
| Plans | Pending/in-progress/completed | P0 | Map Pi-Tai work context and default omitted Pi priorities to `medium`; ACP v2 also defines `cancelled`, which Pi-Tai does not emit initially. |
| Plans | Goal metadata | P0 | Keep canonical goal in Host state; use namespaced `_meta` only if useful. |
| Plans | External plan replacement | P1 | Product API command, not assumed to be ACP. |
| Plans | Multiple/other plan variants | P2 | Initial session uses one stable work-context plan ID. |
| Config | Main model selector | P0 | `configId`, `category: model`; no dedicated model method. |
| Config | Main effort selector | P0 | `category: thought_level`. |
| Config | Complete config replacement updates | P1 | `config_option_update` and set response return the full array. |
| Config | Boolean options | P1 | Only for genuine boolean state; no unsafe bypass mode. |
| Metadata | Automatic/live title | P0 | `session_info_update` patch semantics. |
| Metadata | Context usage, size, and cumulative cost | P1 | ACP v2 `usage_update`. |
| Commands | Prompt templates and skills | P0 | `available_commands_update`; text input carries `type: text`. |
| Commands | Dynamic argument hints/updates | P1 | Refresh after reload. |
| Permission | ACP v2 permission requests | P0 | Required title, optional description, extensible subject. |
| Permission | Guardian automatic decision | P0 | Primary Pi-Tai gate; unknown outcomes never imply approval. |
| Permission | Tool-call and command subjects | P0 | Command subject requires absolute cwd; associations are optional. |
| Auth | Detect missing Pi auth | P0 | Return auth-required behavior accurately. |
| Auth | Agent-managed login and logout | P0 | If any `authMethods` are advertised, both `auth/login` and `auth/logout` are implemented. |
| Filesystem | Client filesystem delegation | Out | Removed from ACP v2; local tools or MCP instead. |
| Terminal | Client terminal execution/control | Out | Removed from ACP v2; display terminals are Agent-owned. |
| MCP | stdio and HTTP server config | P2 | Tagged transports; no deprecated SSE transport. |
| Provider | Client provider management | P2 | Experimental. |
| Elicitation | Form and URL elicitation | P2 | Capability-dependent. |
| Editor | Document events and position encoding | P2 | Separate editor-aware phase. |
| NES | Next Edit Suggestions | Out initially | Separate product phase. |
| Extensibility | Custom methods/notifications | P2 | Must use `_` names and negotiated metadata. |
| Transport | Remote ACP HTTP/WebSocket | Out initially | Mobile uses the product API, not ACP. |

## Initial ACP v2/Zed alpha

The first alpha includes:

- exact SDK/schema pinning and ACP v2 draft enablement;
- initialization with required implementation info and complete baseline session capability;
- actionable Host unavailable, auth-required, and version-mismatch errors;
- new, list, resume (with and without full replay), close, prompt, and cancel;
- text, resource-link, image, and stable user-message acknowledgement;
- `running`/`requires_action`/`idle` state projection and background updates while idle;
- streaming and replaceable assistant messages with stable IDs;
- `tool_call_update`, streamed tool content, structured diffs, locations, and display terminals;
- item-based `plan_update` with one stable plan ID;
- session titles, model and thought-level config options, commands, and skills;
- Guardian enforcement and ACP v2 permission presentation;
- disconnect/reconnect without cancelling the Host-owned session.

Stock Zed acceptance requires a Zed build that negotiates ACP v2. Before that exists, H5 uses the official SDK test client and independently authored fixtures; lack of a v2 Zed build does not justify adding v1 semantics to the Host.

## Required fixture suite

Before production hardening, fixtures cover:

- initialize success, v1 mismatch, omitted capabilities, and malformed known values;
- JSON-RPC single messages, mixed batches, notification-only batches, and invalid entries;
- prompt response ordering, user acknowledgement, running, idle, and background idle updates;
- prompt rejection before acceptance and second-prompt rejection while busy;
- cancellation with late tool updates followed by idle/cancelled;
- resume without replay and replay-from-start with a live-event barrier;
- stable message IDs, replacement, clear, and append behavior;
- tool first-seen upsert, patch clear, content replacement, and content chunks;
- terminal snapshot replacement, independently decoded byte chunks, split/invalid UTF-8, and exit status;
- structured add/delete/modify/move/copy and patch-less binary diffs;
- permission request title/description, tool-call subject, command subject, cancelled outcome, and unknown non-approval outcome;
- complete plan replacement by `planId`, explicit priorities, and the documented non-emission of cancelled entries;
- complete config option replacement and dependent option changes;
- unknown future and `_`-prefixed variants at each supported fallback boundary.

## Host boundary

The ACP shim:

- owns no database or Pi process;
- may be terminated by Zed without cancelling the broker session;
- treats explicit `session/close` differently from process disconnection;
- advertises only capabilities implemented by the complete Zed → shim → Host → Pi pipeline;
- relays durable Host item identities and normalized events rather than reconstructing history from Zed storage;
- leaves non-ACP mobile controls, including external plan editing, on the versioned product API.

Supporting arbitrary downstream ACP agents is out of scope. Pi is the initial and only Host runtime.

## Draft upgrade policy

For every ACP v2 alpha update:

1. read the migration notes and schema diff;
2. update the exact SDK, schema release, checksum, and source revision together;
3. regenerate or replace independently authored wire fixtures;
4. run wire-to-domain conversion tests before changing broker code;
5. document semantic changes in this scope or a new ADR;
6. rerun the official SDK client proof and available Zed v2 smoke test.

Draft schema churn alone should change the ACP adapter and fixtures. A broker migration is justified only when the semantic product model changes.
