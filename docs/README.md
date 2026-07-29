# Pi-Tai documentation

Pi-Tai is a machine-bound agent platform built around Pi. A long-lived Host owns durable sessions and machine capabilities; a shared core implements session and agent behavior; CLI, desktop, ACP, and future remote applications are clients of the Host.

These documents describe the **intended end state**. They are not organized around the repository's current directory layout. Current implementation state, migration work, and sequencing live only under [Roadmap](roadmap/README.md).

## Product and system

- [Product](PRODUCT.md) — promise, users, principles, goals, and non-goals.
- [System architecture](architecture/README.md) — complete end-state component model and dependency direction.
- [Core](architecture/CORE.md) — reusable domain and application services.
- [Host](architecture/HOST.md) — machine identity, background lifecycle, runtime supervision, and authority.
- [Sessions and persistence](architecture/SESSIONS.md) — canonical state, event ordering, recovery, and retention.
- [Clients](architecture/CLIENTS.md) — Pi CLI, custom CLI, desktop, ACP, local IPC, and remote access.
- [Protocol boundaries](architecture/PROTOCOLS.md) — Host-client, Host-runtime, ACP conversion, replay, and versioning.
- [Machine capabilities](architecture/CAPABILITIES.md) — Guardian-governed filesystem, shell, web, browser, computer, and image capabilities.
- [Repository shape](architecture/REPOSITORY.md) — target packages, applications, services, crates, and dependency rules.
- [Terminology](GLOSSARY.md) — stable names used across the documentation.

## Agent concurrency and JJ

Agent concurrency is a core Pi-Tai capability.

- [Subagents and workspaces](concurrency/README.md) — harnesses, isolation, model selection, result delivery, the tool surface, and the JJ workspace lifecycle.

## Roadmap

- [Roadmap index](roadmap/README.md) — initiative order, dependencies, status, and exit outcomes.
- [Initiatives](roadmap/initiatives/) — one bounded migration or product outcome per document.

## Documentation rules

1. Documents outside `roadmap/` describe the intended system and avoid transient implementation status.
2. Roadmap initiatives describe the delta from the current repository to that intended system.
3. Domain behavior is documented independently from a particular transport, database, process, or UI.
4. There is one authoritative definition for every stateful concept; other documents link to it.
5. The Host is the sole durable session authority. Clients cache projections only.
6. Models choose semantic intent; deterministic code owns identity, locks, mutation ordering, and receipts.
7. Historical documents are source material, not a second normative documentation tree. Relevant decisions are incorporated here or retired explicitly by a roadmap initiative.
