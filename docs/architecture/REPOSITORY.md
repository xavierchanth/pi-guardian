# Repository shape

## Goal

The repository mirrors product and deployment boundaries without splitting every internal subsystem into a package.

## Target layout

```text
pi-tai/
├── package.json                  Git-installable distribution/workspace root;
│                                 declares both entry points (see Distribution)
├── packages/
│   ├── core/                     @pi-tai/core
│   ├── pi-cli/                   Pi terminal presentation and client adapters
│   ├── client/                   shared typed Host client when justified
│   ├── host-protocol/            client ↔ Host semantic wire contract
│   └── runtime-protocol/         Host ↔ runtime-worker contract
├── services/
│   └── pi-runtime/               Pi SDK worker embedding @pi-tai/core
├── apps/
│   └── host/                     Host packaging and desktop/tray client
├── bins/
│   ├── acp/                      thin ACP adapter
│   ├── pi-tai-client/            Pi-derived ACP terminal client
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

Exact names may change without changing dependency direction or authority.

## Distribution and entry points

Pi terminal presentation, the Host-backed `pi-tai-client`, and any Pi client adapter ship as one
versioned distribution rather than independently versioned products. `@pi-tai/core` and protocol
packages are shared by construction rather than synchronized publishing.

Entry points may differ in presentation or launch environment, but all Host-backed entry points:

- visibly report Host connection failure rather than falling back to local execution;
- use Host session identity and storage rather than private durable transcripts;
- obey the client import rule below.


### Dependency resolution

An adapter loaded into a Pi installation treats Pi packages as peers; the standalone client bundles
what it needs at build time. No loaded adapter may resolve a second Pi runtime or create a hidden
local `AgentSession`, because that would reintroduce a second execution authority.

## Package responsibilities

### `@pi-tai/core`

Contains reusable TypeScript domain and application services. No terminal, React, Tauri, ACP, local-IPC, or concrete database imports.

### Pi terminal distributions

`pi-tai-client` is an executable with:

- a Pi-derived interactive TUI;
- an ACP interactive-session backend and Host connection lifecycle;
- ACP event projection and replay-cursor handling;
- ANSI themes, footer, response editor, keybindings, renderers, and terminal notifications;
- no local agent session, model loop, tool executor, or durable transcript.

Presentation assets may be shared where doing so does not pull Pi or terminal dependencies into
`@pi-tai/core`.

Pi publishes its interactive components and theme as public exports, separately from its agent
harness. `pi-tai-client` composes those exports directly; it does not fork Pi, and it does not
require an upstream interactive-session seam in order to exist. The forked-variant fallback
applies only if that export surface proves insufficient in practice.

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
- `pi-tai-client` may import Pi's presentation exports — components, theme, renderers, key
  handling — and may not import its harness: `AgentSession`, `AgentSessionRuntime`,
  `createAgentSession*`, `SessionManager`, `ModelRuntime`, or the tool constructors. This is the
  structural form of "no hidden local agent session"; it is a static import check rather than a
  runtime assertion about an absent process.

## Documentation and release shape

- End-state docs are shipped only when useful to users or contributors.
- Historical source documents are not included in release tarballs by default.
- Generated UI bundles and runtime-packaging output are built for releases, not tracked unless a packaging constraint is documented.
- `target/`, temporary source clones, eval output, journals, and machine-local state are ignored.
- Package tests assert the intended tarball exactly.

## Change discipline

Move behavior behind interfaces before moving directories. A directory extraction does not combine unrelated behavioral rewrites. Compatibility paths are deleted only after all production callers use the new authority boundary and durable migration evidence exists.
