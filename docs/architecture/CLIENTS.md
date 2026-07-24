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
├── replace work context or supported configuration
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
├── work-context replacement
├── foreground/runtime state
├── interaction lifecycle
├── child/review/workspace projection
├── session metadata
└── usage replacement
```

Every mutating command has an operation ID. Revision-sensitive commands carry an expected revision. Event streams have ordered cursors.

## Pi CLI adapter

The existing Git-installable Pi extension can become a Host client while preserving Pi's mature TUI.

Client-specific responsibilities:

- connect to or start the local Host;
- create/attach/resume Host sessions;
- map Host events into Pi's extension/UI lifecycle;
- ANSI themes and terminal background polling;
- footer and work-context rendering;
- external response editor;
- keybindings and model-profile shortcuts;
- terminal notifications;
- client-local drafts.

The adapter must not start an independent authoritative Host-managed session from local Pi files. Standalone unmanaged Pi operation may remain an explicit separate mode during migration, never an ambiguous fallback.

## Custom CLI

A custom CLI is optional. It becomes justified if Pi's extension surface cannot express:

- Host/session dashboards;
- multiple simultaneous attachments;
- detached background commands;
- richer reconnect streaming;
- remote Host selection;
- machine and workspace administration.

The client contract allows this without changing the core or persistence model.

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
