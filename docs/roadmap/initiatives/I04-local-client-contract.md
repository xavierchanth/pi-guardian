# I04 — ACP client contract and CLI cutover

**Status:** Planned  
**Depends on:** I02, I03

## Outcome

ACP-facing clients use one negotiated ACP session surface backed by the typed Host command/query/event contract. Desktop may consume the native Host client contract for management. A new `pi-tai-client` executable reuses Pi's TUI as a presentation-only ACP client and owns no agent harness, execution, configuration, or session persistence. The current direct `pi-tai` extension remains separately available during migration.

## Scope

- Stabilize transport-neutral command/query/event semantics.
- Add operation IDs, expected revisions, cursors, capability negotiation, and error taxonomy.
- Build shared connection/replay client code when two callers justify it.
- Introduce or maintain a narrow Pi interactive-session backend seam.
- Build `pi-tai-client` as a separate executable whose backend is ACP rather than Pi's local `AgentSessionRuntime`, composed from Pi's published presentation exports rather than a fork.
- Project ACP updates into Pi's TUI while keeping ANSI themes, footer, editor, keybindings, renderers, drafts, and notifications local.
- Prohibit a hidden local `AgentSession`, local model loop, local tool execution, or shadow durable transcript in `pi-tai-client`.
- Retain the existing Git-installable `pi-tai` extension as explicit legacy direct mode during migration; it cannot hand off its local sessions to Host clients.
- Never silently fall back from `pi-tai-client` to direct Pi execution.
- Add local enrollment/authentication and protocol-version handshake.
- Prove reconnect and backpressure.

## Exit criteria

- Closing `pi-tai-client` detaches without ending Host work or approved commands.
- Reopening from a cursor receives no duplicate/lost durable event.
- Terminal-specific behavior remains absent from headless/ACP/runtime modes.
- Clients cannot open Host storage or private journals directly.
- Host-unavailable, auth, stale revision, and version mismatch are actionable.
- Zed, T3 Code, and `pi-tai-client` can attach sequentially to one Host session using stable identity and replay cursors.
- A static import check proves `pi-tai-client` never reaches Pi's agent harness; integration tests confirm no local agent/model/tool runtime is active.
- Legacy `pi-tai` and Host-backed `pi-tai-client` are visibly distinct commands and stores. They ship as one artifact with two entry points; distinct published packages are explicitly not required.
- ACP terminal updates are display-only: the Host owns execution, commands survive disconnect unless cancelled, and PTY/stdin takeover is out of scope.
