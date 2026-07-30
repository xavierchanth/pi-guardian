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

## Current component disposition

This inventory is the canonical I00 classification. “Unresolved” is intentional: it prevents a
proof from silently becoming architecture before its replacement is demonstrated.

| Component | Disposition | Rationale or bounded next action |
|---|---|---|
| `apps/host` | **Retain** | Desktop/Tauri packaging and Host UI remain a product boundary. The proof-era UI/runtime composition is unresolved pending I10's client-contract review; do not remove it before a replacement lifecycle smoke exists. |
| `bins/acp` | **Retain** | Thin ACP adapter is a distinct client boundary; I04 must verify it contains no session authority. |
| `bins/ctl` | **Retain** | Rust diagnostics/administration client has a distinct operational role. |
| `crates/broker` | **Unresolved: merge or retain** | It is currently used by `host-kernel` and `host-server`, but may duplicate the eventual session service. I02 must map its aggregate/API to the canonical session aggregate and record a merge plan or a distinct responsibility. |
| `crates/config` | **Retain** | Shared typed Host configuration is independently testable. Revisit only if I01/I03 show it is a forwarding layer. |
| `crates/event-store` | **Retain** | Durable storage adapter is distinct from session policy and transport. |
| `crates/host-kernel` | **Retain** | Host orchestration boundary; I02 must remove any authority duplicated by `broker`, not the boundary itself. |
| `crates/host-lifecycle` | **Unresolved: merge or retain** | Proof-era lifecycle boundary may remain a platform-neutral service. I10 must compare it with Tauri lifecycle code and merge forwarding-only code. |
| `crates/host-platform` | **Unresolved: merge or retain** | Proof-era platform adapters are plausible but not yet justified independently. I10 must inventory native implementations and ownership. |
| `crates/host-protocol` | **Retain** | Rust client↔Host wire contract and generated-language source boundary. |
| `crates/host-server` | **Retain** | Local server/transport composition is distinct from the session domain. |
| `crates/local-ipc` | **Retain** | Local IPC is an independently testable transport. |
| `crates/runtime-protocol` | **Retain** | Rust-first Host↔worker contract is separate from the client protocol. |
| `crates/runtime-supervisor` | **Retain** | Worker process supervision is a Host responsibility distinct from runtime behavior. |
| `packages/host-client` | **Retain for now** | Shared typed client exists; I04 must confirm both ACP and desktop use it before treating the extraction as final. |
| `packages/host-protocol` | **Retain** | Generated TypeScript client↔Host DTO package mirrors the Rust source of truth. |
| `packages/pi-tai` | **Unresolved: move/split** | Current shipped extension contains presentation and domain behavior. I01 decides movement into `core`/Pi adapter boundaries; retain in place until behavior is covered behind interfaces. |
| `packages/runtime-protocol` | **Retain** | Generated TypeScript worker DTO package mirrors the Rust source of truth. |
| `services/pi-runtime` | **Retain, then repair imports** | Executable Pi SDK worker is the intended deployment boundary. Its direct relative imports from `packages/pi-tai` violate the target boundary; I01 must extract stable exports and I03 must switch the service, with tests, before those imports are removed. |
| `tests` | **Retain** | Cross-boundary integration, runtime, repository, smoke, and focused unit verification belongs outside individual deployables. |
| `evals` | **Retain** | Opt-in behavioral benchmarks are engineering evidence, not shipped runtime authority. |
| `fixtures` | **Retain** | Shared protocol and cross-language conformance data must remain consumable by both toolchains. |
| `scripts` | **Retain** | Repository-level generation, packaging, and verification automation spans package boundaries. |

There are no other top-level children under `apps/`, `bins/`, `crates/`, `packages/`, or `services/`
at this revision.

### Decisions deliberately not inferred from proof code

- **Broker versus session service:** unresolved as described above; present call sites prove use, not
  a distinct long-term responsibility.
- **Persisted versus wire events:** wire DTOs are not persistence schema. Existing sharing is
  unresolved technical debt; I02 must either introduce a versioned persisted event type and mapper,
  or document and test an intentional coupling before I00 can be complete.
- **Proof-era Tauri, ACP, and runtime layers:** retain operational entry points while I04/I10 classify
  forwarding and duplicated-authority internals. No wholesale removal is authorized by I00.
- **Generated desktop output:** `apps/*/src-tauri/gen/`, app `dist/`, repository `dist/`, runtime
  packaging output, and dependencies/build output are ignored and must be produced in release jobs,
  not tracked. A future exception requires a documented packaging constraint and reproducibility test.

## Engineering toolchain

Biome 2.2.7 is the pinned TypeScript/JavaScript formatter and linter. It is a single low-dependency,
Node 22-compatible binary with one configuration for deterministic LF, spacing, and lint rules.
`npm run format`, `format:check`, and `lint` (also exposed by `just`) currently enforce the initial
`packages/pi-tai/src/concurrency` and `src/jj` adoption boundary. Expand `biome.json` by reviewed
subtree; this avoids disguising behavior changes in a repository-wide initial rewrite. Generated,
dependency, and build directories are excluded both there and in `.gitignore`.

Rust formatting and clippy gating is boundedly deferred: `cargo fmt --all -- --check` currently
reports pre-existing formatting drift in `crates/event-store` and `crates/host-kernel`. CI must add
`cargo fmt --all -- --check` and `cargo clippy --workspace --all-targets -- -D warnings` once that
bounded debt is repaired in a dedicated Rust-only change, rather than mass-formatting it here.
`/btw` token accounting is also deferred because integrating its available completion usage into
session-wide footer/accounting semantics requires a separate, broader change.

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
