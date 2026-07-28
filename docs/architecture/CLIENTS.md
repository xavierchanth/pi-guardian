# Clients and protocols

## Principle

Clients present and control Host-owned sessions. They do not execute a parallel copy of session semantics or open Host persistence directly.

## Common client contract

Transport-neutral concepts:

```text
commands
├── create/list/get/attach/close session
├── submit prompt
├── cancel current operation
├── answer interaction
├── invoke scoped task/event/review commands or supported configuration
├── send steering/follow-up
└── invoke authorized session capability

queries
├── session snapshot
├── capability and model catalog
├── runtime/Host health
├── child/workspace status
└── usage and diagnostics

events
├── item upsert/chunk
├── tool/terminal update
├── bounded task/concurrency replacement
├── foreground/runtime state
├── interaction lifecycle
├── child/review/workspace projection
├── session metadata
└── usage replacement
```

Every mutating command has an operation ID. Revision-sensitive commands carry an expected revision. Event streams have ordered cursors.

Concurrency projections contain bounded semantic task, child, question, finding, claim, workspace-custody, receipt, incident, and exact-usage summaries. They never contain transcripts, raw message histories, private journal/session paths, PIDs, control channels, or a client action for entering a child context.

## Pi terminal client

`pi-tai-client` is a Pi-derived executable that reuses Pi's terminal presentation while replacing
the local agent harness with an ACP client connected through the ACP shim to the Host. It never
falls back to local execution when the Host is unavailable.

```text
Pi TUI → interactive-session backend → ACP shim → Host → runtime worker
```

Client-specific responsibilities:

- connect to or start the local Host and ACP shim;
- create, attach, resume, and detach Host sessions using stable IDs and replay cursors;
- project ACP session, message, tool, terminal, plan, mode, and interaction updates;
- ANSI themes and terminal background polling;
- footer and bounded task/concurrency rendering;
- external response editor and client-local drafts;
- keybindings and model-profile shortcuts expressed as ACP commands;
- terminal notifications and reporting-only cmux status, progress, logs, and alerts.

The executable creates no local `AgentSession`, model loop, tool executor, or durable shadow
transcript. A stock extension that intercepts input while Pi's hidden local session remains active
does not satisfy this boundary. Prefer a narrow Pi interactive-session backend seam; maintain the
smallest practical Pi variant or compose from Pi's TUI components if that seam is not available
upstream.

### Handoff

Handoff means detaching one ACP client and attaching another to the same Host session and event
cursor. No agent runtime or transcript migrates between clients. Closing `pi-tai-client` leaves
healthy Host work and approved commands running.

## Future custom CLI

A non-Pi custom CLI remains optional. It becomes justified if the Pi-derived client cannot express
Host/session dashboards, multiple simultaneous attachments, richer reconnect streaming, remote
Host selection, or machine/workspace administration. It must use the same ACP boundary rather
than changing core or persistence semantics.

## Desktop

Desktop initially manages:

- Host installation, startup, version, and health;
- model/authentication readiness;
- client enrollment and remote pairing;
- machine capabilities;
- session list and status;
- diagnostics and safe restart controls.

It may later become a full session client. Closing its window does not stop the Host.

## ACP/editor adapter

ACP is a thin disposable protocol adapter:

- it owns no Pi process or database;
- it translates negotiated protocol operations to Host commands;
- Host stable IDs survive live delivery and replay;
- process EOF detaches only;
- explicit session close follows product cancellation/release semantics;
- prompt acceptance responds after durable acceptance, not completion;
- session updates remain legal while foreground state is idle;
- wire DTOs are converted explicitly and never persisted as domain state.

The first adapter can target ACP v2 and Zed without making ACP the internal product API.

## Local transport

Use authenticated local IPC, typically Unix domain sockets on macOS/Linux and an appropriate named-pipe equivalent on Windows.

Requirements:

- peer and installation authentication;
- protocol version negotiation;
- bounded frames and backpressure;
- reconnect and cursor resume;
- no secrets in command-line arguments;
- actionable Host-unavailable and version-mismatch errors.

## Remote transport

Remote access is opt-in and authenticated. Initial deployment may use Tailscale for network reachability, but Pi-Tai still performs product-level pairing and authorization.

Remote permissions distinguish:

- list/observe sessions;
- attach and replay;
- send prompts or steering;
- cancel work;
- answer interactions;
- invoke machine-mutating capabilities;
- administer the Host.

A remote client never receives raw credentials or unrestricted filesystem/process access.

## Multi-Host clients

A client may know several Hosts. Session IDs include or resolve to a home Host. A discovery/control plane can aggregate metadata, but commands route to the authoritative Host. Cross-Host session movement is a separate future operation, not client-side copying.
