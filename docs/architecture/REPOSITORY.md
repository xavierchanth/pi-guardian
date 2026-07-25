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
│   ├── pi-cli/                   legacy direct Pi extension and shared terminal presentation assets
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

Exact names may change during migration. Dependency direction and authority are normative.

## Distribution and entry points

The legacy direct extension and `pi-tai-client` ship as **one published artifact with two entry
points**, not as two packages. The root manifest declares both:

```jsonc
{
  "pi":  { "extensions": ["./packages/pi-cli/pi-tai.ts"] },  // loaded into the user's Pi
  "bin": { "pi-tai-client": "./bins/pi-tai-client/main.ts" } // standalone ACP client
}
```

One manifest, one release, one version number. `@pi-tai/core` and the protocol packages are
shared by construction rather than by synchronised publishing.

The separation that matters is behavioural, and is enforced by three things that are *not*
package boundaries:

- **Distinct commands.** `pi` with the extension loaded, versus `pi-tai-client`. A user can
  always tell which product they are in.
- **Distinct state roots.** Legacy local sessions and Host-backed sessions never share storage.
  Both sit under the XDG roots, under separate paths, so neither can read the other's durable
  state.
- **Distinct import surfaces.** See the client import rule below.

Splitting into two published packages buys none of these and costs a second release pipeline
plus version-skew management between the client and the core it depends on.

### Dependency resolution

The two entry points want different dependency treatments: the extension is loaded into a Pi the
user already has, so Pi packages are peers; the client binary is standalone and must resolve its
own. Keep Pi packages as `peerDependencies` for the extension path and bundle what the client
needs at build time. Promoting Pi to a hard dependency of the root manifest is prohibited: it can
resolve a second copy of Pi into the legacy install path, which means two `AgentSession` classes
and a dual-authority bug of exactly the kind this architecture exists to prevent.

## Package responsibilities

### `@pi-tai/core`

Contains reusable TypeScript domain and application services. No terminal, React, Tauri, ACP, local-IPC, or concrete database imports.

### Pi terminal distributions

The repository root may continue to expose the legacy direct `pi-tai` extension for Git-based Pi
installation during migration. It contains the existing Pi harness composition and remains
explicitly separate from Host-backed sessions.

`pi-tai-client` is a separate executable with:

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

## Migration principle

Move behavior behind interfaces before moving directories. A directory extraction must not combine unrelated behavioral rewrites. Delete compatibility paths only after all production callers use the new authority boundary and durable migration evidence exists.
