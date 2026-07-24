# Repository shape

## Goal

The repository mirrors product and deployment boundaries without splitting every internal subsystem into a package.

## Target layout

```text
pi-tai/
├── package.json                  Git-installable distribution/workspace root
├── packages/
│   ├── core/                     @pi-tai/core
│   ├── pi-cli/                   Pi extension and terminal presentation
│   ├── client/                   shared typed Host client when justified
│   ├── host-protocol/            client ↔ Host semantic wire contract
│   └── runtime-protocol/         Host ↔ runtime-worker contract
├── services/
│   └── pi-runtime/               Pi SDK worker embedding @pi-tai/core
├── apps/
│   └── host/                     Host packaging and desktop/tray client
├── bins/
│   ├── acp/                      thin ACP adapter
│   └── ctl/                      Host diagnostics/administration
├── crates/
│   ├── host-kernel/
│   ├── host-server/
│   ├── event-store/
│   ├── broker/                   retain only if distinct from session service
│   ├── local-ipc/
│   ├── runtime-supervisor/
│   ├── host-lifecycle/
│   └── host-platform/
├── docs/
│   ├── architecture/
│   ├── concurrency/
│   └── roadmap/initiatives/
├── fixtures/                     cross-language and wire fixtures
├── tests/                        cross-boundary integration/repository tests
└── evals/                        opt-in agent behavior benchmarks
```

Exact names may change during migration. Dependency direction and authority are normative.

## Package responsibilities

### `@pi-tai/core`

Contains reusable TypeScript domain and application services. No terminal, React, Tauri, ACP, local-IPC, or concrete database imports.

### Pi CLI distribution

Contains:

- Pi extension composition;
- terminal lifecycle adapters;
- agents/prompts/skills packaged for Pi where presentation/runtime loading requires them;
- ANSI themes;
- footer, response editor, keybindings, and terminal notifications;
- Host connection and event projection.

The repository root may continue to expose this package directly for Git-based Pi installation.

### Client and protocols

Create `@pi-tai/client` only when two clients share connection/replay logic. Keep Host and runtime protocols separate because they describe different trust and lifecycle boundaries.

### Runtime worker

Composes core with Pi SDK adapters and private journals. It is an executable service, not a second library of session behavior.

### Rust crates

Retain a crate when it has one independently testable Host responsibility. Merge proof-era crates if they only forward calls or duplicate one session aggregate.

## Dependency rules

```text
pi-cli ─────────────┐
desktop ────────────┼─> client/protocol ─> Host
ACP ────────────────┘

Host ─> runtime protocol ─> pi-runtime ─> @pi-tai/core
Host ─> persistence/process/native adapters
@pi-tai/core ─> abstract ports and Pi SDK boundary only
```

- `@pi-tai/core` cannot depend on `@pi-tai/pi-cli`.
- Host persistence crates cannot depend on ACP wire DTOs.
- Pi CLI cannot import event-store internals.
- Runtime protocol does not expose filesystem paths or credentials unnecessarily.
- Shared generated DTOs have an explicit source of truth and check mode.
- No top-level application reaches into another application's source directory.

## Documentation and release shape

- End-state docs are shipped only when useful to users or contributors.
- Historical source documents are not included in release tarballs by default.
- Generated UI bundles and runtime-packaging output are built for releases, not tracked unless a packaging constraint is documented.
- `target/`, temporary source clones, eval output, journals, and machine-local state are ignored.
- Package tests assert the intended tarball exactly.

## Migration principle

Move behavior behind interfaces before moving directories. A directory extraction must not combine unrelated behavioral rewrites. Delete compatibility paths only after all production callers use the new authority boundary and durable migration evidence exists.
