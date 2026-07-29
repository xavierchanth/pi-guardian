# Pi-Tai core

## Purpose

The core is the reusable implementation of Pi-Tai's session and agent behavior. Every application consumes it directly or through a Host-supervised worker. It contains no terminal, desktop, tray, or wire-protocol presentation.

## Responsibilities

- session runtime semantics;
- work context and task plans;
- agent definitions, role authority, and routing;
- parent/child concurrency and usage accounting;
- Guardian policy and review requests;
- semantic machine-capability contracts;
- JJ/workspace coordination policy;
- session naming, model, effort, and compaction policy;
- domain events and persistence interfaces.

## Service shape

Representative only:

```ts
interface PiTaiCore {
  sessions: SessionRuntime;
  workContext: WorkContextService;
  agents: AgentCoordinator;
  guardian: ActionReviewer;
  workspaces: WorkspaceCoordinator;
  capabilities: CapabilityService;
  usage: UsageService;
  dispose(): Promise<void>;
}
```

The core receives explicit ports:

```ts
interface PiTaiCorePorts {
  sessions: SessionRepository;
  events: EventAppender;
  artifacts: ArtifactStore;
  models: ModelGateway;
  piSessions: PiSessionFactory;
  machine: MachineCapabilities;
  jj: JjOperations;
  clock: Clock;
  ids: IdGenerator;
}
```

Ports describe behavior, not implementation technology. SQLite, Pi journals, Unix sockets, subprocesses, and Tauri are adapters.

## Internal domains

### Sessions

Validates foreground operations, context continuation, work context, usage, and lifecycle emissions. Product identity remains supplied by the Host.

### Agents and concurrency

Owns task packets, role graph, child contexts, events, acknowledgement, waits, restart intent, file/workspace coordination, and completion gates. See [Concurrency](../concurrency/README.md).

### Work context

Provides:

- lightweight session goal/checklist state;
- durable state-owned task trees for substantial implementation;
- immutable content-addressed Markdown snapshots referenced by the material handed to a subagent;
- projections consumable by any client.

Task state is owned by the Host rather than by a model: production does not expose `update_plan`, and Host-backed task records are authoritative. A subagent does not read this state. It is given its objective, acceptance criteria, and constraints in its charter when it is spawned, and reports back in its final message.

### Guardian

Receives a proposed semantic action, user authorization evidence, task context, role, destination/path evidence, and capability metadata. It returns a strict allow/deny/failure result. It never asks the user for fallback approval.

### Machine capabilities

Core contracts express intent such as reading a file, checkpointing a workspace, fetching a public page, or controlling a browser. Host adapters select actual machine resources. See [Capabilities](CAPABILITIES.md).

## Embedding rules

- The core may use Pi SDK types at the runtime boundary, but domain states do not depend on TUI objects.
- The core never assumes its caller is interactive.
- Configuration is immutable per loaded revision and injected through a service.
- Every mutable operation is abortable or reconciled through a receipt.
- Domain events carry stable semantic IDs before client projection.
- Internal strict states reject optional-field combinations that could represent contradictory lifecycles.
- Migration DTOs may be permissive; conversion to domain types either succeeds exactly or quarantines the record.

## Core versus runtime worker

The core is a library. A runtime worker is one deployment adapter that:

- creates Pi SDK sessions;
- provides model authentication and resources;
- receives Host commands;
- emits typed core events;
- manages private Pi journals;
- reports health and quiescence.

A worker crash must not erase Host session truth. A worker cannot become a second session authority merely because it stores Pi journals.
