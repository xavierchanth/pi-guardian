# Product

## Product statement

Pi-Tai is a local-first, machine-bound agent platform built around Pi.

> Start or attach to one durable agent session from a terminal, editor, desktop application, or remote client; disconnect any client without losing the session; and continue controlling the same authoritative work on the machine that owns its resources.

Pi-Tai combines:

- a shared agent and session core;
- a long-lived machine Host;
- durable multi-client sessions;
- safe access to machine capabilities;
- structured agent concurrency;
- deterministic JJ work coordination;
- app-specific clients and protocol adapters.

## Users

### Terminal user

Uses Pi's CLI or a future Pi-Tai CLI, receives the complete agent experience, and benefits from terminal-specific themes, keybindings, editor integration, footer status, and notifications.

### Desktop user

Manages Host readiness, machine capabilities, configuration, and durable sessions through a native application. Desktop presentation does not own session truth.

### Editor user

Attaches an editor such as Zed through a thin protocol adapter. Closing the editor detaches the client rather than terminating healthy Host work.

### Remote user

Pairs a client with a selected Host, observes sessions, and later controls them through authenticated transport. Every session retains one home Host and one active writer authority.

## Product principles

1. **One session authority.** The Host owns canonical session identity, events, lifecycle, and recovery.
2. **One behavioral core.** CLI, desktop, ACP, and workers consume the same session and agent semantics rather than reimplementing them.
3. **Clients are replaceable.** UI state may be local; durable product state is reconstructable from the Host.
4. **Machine capabilities remain local.** Filesystems, credentials, workspaces, browser state, and processes belong to a Host and are never implied to be globally portable.
5. **Background work survives clients.** A client disconnect does not cancel a healthy session or child agent.
6. **Concurrency preserves ownership.** Parallel work uses explicit task, file, workspace, review, and integration boundaries.
7. **Safety is capability-wide.** Guardian policy applies regardless of which client or agent requested an action.
8. **Local first, remote ready.** Local IPC is the first transport; protocol semantics do not depend on it.
9. **Honest recovery.** Pi-Tai never claims an in-flight operation survived when only durable history survived.
10. **No automatic publication.** Pushes, bookmarks, pull requests, and destructive recovery require separate explicit workflows.

## Product capabilities

- Durable sessions with ordered replay and reconnect cursors.
- Pi SDK-backed agent execution and configurable models.
- Work context and durable state-owned task trees with immutable snapshots.
- Private in-process child agents with bounded parent/child messages.
- Shared-source and isolated JJ execution lanes.
- Independent review before isolated work integrates.
- Guardian-governed machine and network operations.
- Web research and safe public fetching.
- cmux session-presence integration, with future browser, computer, image, and agent-driven cmux capabilities.
- Multiple presentation clients over one Host API.
- Per-session and per-child usage accounting.

## Non-goals

- Treating every Pi session on a machine as automatically Host-managed.
- Running arbitrary downstream agent runtimes before the Pi runtime is mature.
- Sharing an editor's private session database.
- Preserving an active tool process across complete machine failure.
- Moving live sessions between machines without explicit lease, artifact, workspace, and capability-transfer protocols.
- Exposing a public unauthenticated Host listener.
- Automatic publishing or destructive version-control recovery.
- Making child contexts user-selectable chat sessions.
- Building a generic plugin framework in competition with Pi's extension system.

## Success criteria

Pi-Tai reaches its intended product shape when:

- the Host can create, resume, and recover authoritative sessions;
- stock Pi CLI, desktop, and ACP consume the same client contract;
- the shared core contains no terminal or desktop presentation dependency;
- all new child agents use the concurrency runtime and all writes follow ownership rules;
- shared and isolated JJ workflows produce deterministic receipts;
- nonempty isolated changes cannot integrate without bounded independent review;
- clients can reconnect and replay without duplicates;
- remote transport can be added without changing session semantics;
- legacy parallel session, subprocess, and workspace authorities are removed.
