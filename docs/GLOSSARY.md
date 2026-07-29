# Terminology

| Term | Definition |
|---|---|
| **Pi-Tai core** | Reusable domain and application services implementing session, agent, work-context, concurrency, Guardian, workspace, and usage behavior. |
| **Host** | Long-lived authority for one machine. Owns durable sessions, machine identity, persistence adapters, runtime supervision, and client arbitration. |
| **home Host** | The one Host authoritative for a session. Remote access does not change session ownership. |
| **client** | Replaceable presentation or protocol process attached to the Host, such as Pi CLI, desktop, ACP, or a remote application. |
| **runtime worker** | Host-supervised process that embeds Pi SDK and the Pi-Tai core to execute sessions. It does not independently own product state. |
| **session** | Durable Host-owned thread of user commands, agent events, work context, child topology, usage, and resource custody. |
| **foreground operation** | One accepted prompt or interaction cycle whose state is idle, running, or requires action. |
| **event cursor** | Monotonic position in one session's ordered durable event stream, used for replay and optimistic concurrency. |
| **projection** | Rebuildable view derived from canonical events and snapshots for a client or protocol. |
| **subagent** | Background agent given one self-contained objective, its own context window, and a working directory. It cannot see the parent conversation, and its final message is its entire report. |
| **harness** | Runtime that executes a subagent — `pi`, `claude`, or `codex` — translated into one neutral event stream. |
| **isolation** | Where a subagent works: `workspace` gives it its own JJ checkout, `shared` puts it in the user's working copy. It names a location, not a permission. |
| **model alias** | Short name — `sol`, `opus`, or `fable` — carrying a model, a reasoning effort, and the harness it runs on. |
| **child context** | Private managed Pi SDK `AgentSession` linked to one parent and excluded from user session navigation. |
| **execution cycle** | One concrete run or recovery attempt of a durable child context. |
| **charter** | System prompt given to a subagent, fixing the objective, the acceptance criteria, the constraints, and how to leave its workspace. |
| **work context** | Current goal and execution checklist associated with a session or context. |
| **orchestration change** | Mutable private per-session JJ change, described `pi-tai: session <id>`, preserving that Host session's integrated work without moving or rewriting the invoking user workspace. |
| **source base** | The invoking workspace's single parent, `@-`, recorded as the stable insertion and rebase anchor for managed work. |
| **source working change** | The user's live source `@`; Pi-Tai may observe its identity and content for guarded checkpointing but never describes or rewrites it. |
| **shared lane** | Bounded implementation in the source workspace under an atomic file-set claim and assigned feature Change ID. |
| **isolated lane** | Substantial or overlap-prone implementation in a separate JJ workspace rooted from source `@-`. |
| **file-set claim** | Atomic exclusive ownership of a canonical set of source paths through edit, validation, checkpoint, and receipt verification. |
| **workspace custody** | Durable Host/core responsibility for an isolated workspace from allocation through review, integration, closure, or incident. |
| **workspace writer token** | Exclusive authority for one writable context to mutate and checkpoint an isolated workspace. |
| **Change ID** | Stable JJ change identity across ordinary rewriting. It is authoritative where commit IDs are only observations. |
| **content tip** | Last nonempty tracked Change ID in a frozen workspace, excluding the expected empty working-copy head. |
| **receipt** | Immutable evidence binding an operation's intent, identities, completed boundaries, and verified postconditions. |
| **Guardian** | Pi-Tai policy and reviewer boundary that decides whether proposed machine or network actions may execute. |
| **capability** | Host-advertised machine operation or resource, governed by role and Guardian policy. |
| **attention required** | Preserved state in which automatic mutation stops because identity, ownership, authority, or completed boundaries cannot be proved. |
