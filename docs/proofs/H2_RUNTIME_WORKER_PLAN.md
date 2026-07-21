# H2 Pi SDK runtime-worker proof plan

## Status

Proposed for review. H2 implementation has not started.

H2 is a disposable architecture proof. It must establish that Pi can run reliably behind a supervised, self-contained TypeScript worker before Host-to-worker integration begins in H3. The worker protocol and event mapping remain proof-level until Gate H.

## Outcome

At the end of H2, a packaged `pi-tai-runtime` must be able to:

1. start without a user-managed Node or Bun installation;
2. create a persistent Pi session for an explicit cwd;
3. load Pi-Tai through Pi's SDK resource system;
4. run a deterministic faux-model prompt and stream ordered semantic events;
5. dispose, restart, open the same Pi session file, and continue its history;
6. replace the active SDK session without retaining stale subscriptions;
7. cancel or terminate cleanly without corrupting stdout or the session file.

The proof must not call a paid or remote model.

## Non-goals

H2 does not implement:

- Host Agent process supervision or runtime generations beyond protocol fields;
- authenticated Host IPC;
- broker session IDs, SQLite, revisions, replay, or recovery;
- Zed/ACP translation;
- production permission/question UX;
- final normalized product events;
- universal binaries, signing, notarization, or release packaging;
- real-provider authentication acceptance.

Those boundaries remain H3, H4, H5, or post-Gate-H work.

## Fixed implementation decisions

### Process shape

- Add one npm workspace at `services/pi-runtime`.
- One worker owns at most one loaded `AgentSessionRuntime` at a time.
- stdin/stdout carry versioned JSON Lines only.
- stderr carries structured, redacted diagnostics only.
- The worker owns Pi SDK objects and a Pi session file, but no broker state or client connections.
- H2 uses Node TypeScript execution for development tests and runs the same behavior suite against each packaging candidate.

### Planned repository shape

```text
services/pi-runtime/
├── package.json
└── src/
    ├── bootstrap.ts          stdout guard, signals, deferred worker import
    ├── main.ts               command dispatch and worker state machine
    ├── pi-runtime.ts         AgentSessionRuntime adapter
    ├── event-map.ts          allowlisted Pi-to-worker events
    ├── headless-ui.ts        hosted extension UI bridge
    ├── diagnostics.ts        redacted stderr records
    └── jsonl.ts              bounded framed transport
packages/runtime-protocol/
├── package.json
└── src/                      envelopes, payload types, and runtime decoders
fixtures/runtime-protocol/    valid and invalid cross-process frames
tests/runtime/                spawned-worker SDK and lifecycle tests
tests/smoke/                  packaged-artifact black-box scenario
scripts/runtime-packaging/    Bun, SEA, sidecar, and measurement drivers
```

Generated binaries and measurement output remain ignored artifacts. Stable conclusions move into ADR 0005 rather than committing large build products.

The root `npm run check` must include the runtime protocol and SDK suites; dedicated scripts expose faster `test:runtime`, `runtime-smoke`, and packaging-comparison paths.

### Pi SDK construction

Use the current `@earendil-works/pi-coding-agent` SDK rather than CLI RPC:

1. Create one process-global `ModelRuntime`.
2. Build a `CreateAgentSessionRuntimeFactory` that recreates cwd-bound services with `createAgentSessionServices()`.
3. Create each session with `createAgentSessionFromServices()` and an explicit `SessionManager.create()` or `SessionManager.open()`.
4. Construct the owner with `createAgentSessionRuntime()`.
5. Bind extensions in `rpc` mode.
6. Install `AgentSessionRuntime.setRebindSession()` so every replacement binds extensions and replaces the event subscription.
7. Call `runtime.dispose()` at shutdown.

The proof passes `agentDir`, session directory, and cwd explicitly. Automation uses temporary directories and must not read or write the developer's real `~/.pi/agent` state.

### Pi-Tai loading

Load the Pi-Tai composition root as a named inline SDK extension factory:

```text
DefaultResourceLoader
└── extensionFactories
    └── <inline:pi-tai-hosted>
        └── packages/pi-tai/extension.ts
```

This exercises Pi's SDK resource/extension path while allowing the packaging tool to statically include Pi-Tai. It avoids depending on JIT-loading a repository TypeScript path in the packaged artifact.

The readiness result records, and tests assert, at least:

- the `update_plan` tool is registered;
- `/continue` and `/plan-status` are registered;
- extension loading has no errors;
- ANSI theme handling performs no TTY work in `rpc` mode.

A minimal headless `ExtensionUIContext` converts notifications and extension errors to worker events or redacted diagnostics. Unsupported interactive UI calls fail explicitly rather than hanging.

### Deterministic model

Use Pi AI's exported faux provider for automation. Register its stream with the process-global `ModelRuntime`, set scripted responses before session creation, and disable model-network refresh.

The faux script covers:

- text deltas;
- a deliberately slow response for cancellation;
- a context-sensitive second response proving reopened history reached the model.

The faux path is enabled only by a proof/test launch option. It is not a Host protocol command and cannot silently replace a configured production model.

## Runtime protocol v1 proof

Add explicit TypeScript contracts and decoders under `packages/runtime-protocol`, plus shared fixtures under `fixtures/runtime-protocol`.

### Frame shapes

```ts
interface RuntimeCommand {
  protocolVersion: 1;
  kind: "command";
  id: string;
  method: string;
  params: unknown;
}

interface RuntimeResponse {
  protocolVersion: 1;
  kind: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; retryable: boolean };
}

interface RuntimeEvent {
  protocolVersion: 1;
  kind: "event";
  workerSequence: number;
  runtimeGeneration: number;
  event: string;
  commandId?: string;
  sessionId?: string;
  turnId?: string;
  data: unknown;
}
```

`workerSequence` orders events from one worker generation. It is not the durable Host sequence introduced in H4. H3 supplies and validates `runtimeGeneration`.

### Framing rules

- UTF-8, one JSON object per line, newline terminated.
- `runtime.initialize` must be the first command.
- Command IDs are unique for the worker lifetime.
- Every syntactically valid command receives exactly one response.
- Semantic events may precede or follow the response where documented.
- A prompt response means Pi preflight accepted the turn; `session.idle` signals completion.
- Maximum input line size is fixed and tested; oversized or malformed input receives a structured protocol error.
- Output writes use one serialized writer and honor stream backpressure.
- Unknown methods receive `unsupported_command`; they never terminate the worker.

### Commands implemented in H2

| Command | H2 behavior |
|---|---|
| `runtime.initialize` | Negotiate version, set worker/runtime identity, report capabilities |
| `session.create` | Create a persistent session for cwd and session directory |
| `session.open` | Open or switch to an explicit Pi session file |
| `session.prompt` | Accept one turn with explicit `turnId`; reject a concurrent prompt |
| `session.steer` | Forward explicit steering while streaming |
| `session.follow_up` | Forward explicit follow-up while streaming |
| `session.cancel` | Idempotently abort the targeted active turn |
| `session.set_model` | Resolve and set an available model or return a structured error |
| `session.set_thinking` | Set and report the effective thinking level |
| `session.dispose` | Dispose the loaded SDK runtime and retain persistent history |
| `runtime.shutdown` | Dispose, flush, close protocol output, and exit successfully |

Session create/open/replacement and model mutation are rejected while a turn is active. The command reader remains responsive while `session.prompt()` runs so cancellation and queue commands do not deadlock behind the prompt promise.

### Worker states

```text
starting
  └─ runtime.initialize → ready_without_session
       ├─ session.create/open → session_idle
       │    ├─ session.prompt → turn_active
       │    │    ├─ session.cancel → cancelling → session_idle
       │    │    └─ agent settles → session_idle
       │    ├─ session.open → replacing → session_idle
       │    └─ session.dispose → ready_without_session
       └─ runtime.shutdown → stopping → stopped
```

Any fatal SDK initialization failure emits `runtime.error`, writes a redacted diagnostic, and exits non-zero. A turn failure returns the session to idle and remains distinguishable from process interruption.

## Event mapping

Do not serialize arbitrary Pi event objects. Add an allowlisted mapper for the H2 subset:

- runtime ready/error;
- session ready/replaced/idle;
- agent and turn start/end;
- message start/end;
- assistant text and thinking deltas;
- tool execution start/update/end;
- queue changes;
- session title changes;
- model and thinking changes;
- interruption/cancellation.

Every event includes the current worker sequence and runtime generation. Tool output and transcript content may be protocol data, but stderr diagnostics must contain only IDs, event types, sizes, durations, and redacted error summaries.

## stdout and shutdown discipline

### Protocol-only stdout

Capture the original stdout writer in the JSONL transport and route `console.log/info/warn/error/debug` to the structured stderr diagnostic sink before loading Pi or Pi-Tai. The bootstrap must dynamically load the SDK worker only after installing this guard; packaging tests verify that bundling did not eagerly evaluate worker modules. Guard direct non-transport stdout writes so accidental output fails a test instead of corrupting framing.

Tests parse every stdout line as a runtime frame. A proof extension intentionally calls `console.log`; its text must not appear as a raw stdout line.

### Cancellation and signals

- `session.cancel` targets `turnId` and is idempotent.
- `SIGTERM`/`SIGINT` stop accepting commands, abort an active Pi operation, wait for idle with a short bound, dispose the runtime, and exit.
- A second signal forces exit.
- `runtime.shutdown` uses the same cleanup path.
- The harness verifies bounded exit and a parseable session file after cancellation and termination.

H2 does not claim that arbitrary tools are transactionally reversible.

## Test-first slices

### H2.1 — Protocol and process harness

Red:

- valid/invalid frame decoder tests;
- first-command initialization rule;
- duplicate command ID and unsupported-method tests;
- stdout contamination test;
- spawned-worker timeout and transcript helpers.

Green:

- `packages/runtime-protocol`;
- JSONL reader/writer;
- worker state machine with fake runtime port;
- structured stderr sink.

Checkpoint:

```text
test(runtime): define worker protocol harness
```

### H2.2 — Pi SDK runtime integration

Red:

- Pi-Tai tools and commands appear in readiness capabilities;
- faux prompt emits ordered text and lifecycle events;
- persistent create/dispose/open continues history;
- session replacement emits from the new subscription only;
- cancellation and SIGTERM dispose within the bound;
- no real home-directory or network access.

Green:

- `AgentSessionRuntime` adapter;
- faux `ModelRuntime` setup;
- named inline Pi-Tai resource loading;
- headless extension UI bridge;
- allowlisted Pi event mapper;
- concurrent prompt task plus responsive cancellation.

Checkpoint:

```text
feat(runtime): integrate hosted Pi SDK sessions
```

### H2.3 — Self-contained packaging experiment

Build and run the identical black-box suite against:

1. **Bun standalone executable** — front-runner because Pi itself uses `bun build --compile`.
2. **Node SEA** — a single bundled application image compatible with SEA, injected into the pinned Node 24 executable.
3. **Private Node sidecar bundle** — a pinned Node runtime plus bundled worker/resources inside the application installation, with no dependency on user `PATH`. This is a multi-file fallback, not the preferred one-file artifact.

For each candidate, record:

- build success and reproducibility;
- copied-artifact execution from an empty temporary directory;
- behavior with Node/Bun removed from `PATH`;
- Pi-Tai extension and Guardian loading;
- native/WASM/dynamic asset handling;
- median and p95 `spawn → runtime.ready` over at least 10 warm runs;
- idle and active-turn RSS;
- artifact and installed size;
- cancellation and clean-exit behavior;
- macOS code-signing and Tauri-sidecar implications.

Provisional review flags—not automatic optimization targets—are warm readiness p95 over 2 seconds or idle RSS over 200 MiB per worker.

Write [ADR 0005](../adr/) with the selected route, evidence, rejected alternatives, and known signing/assets work. If no candidate passes from an isolated directory without a user runtime, H2 fails and stops before H3.

Final H2 checkpoint:

```text
feat(runtime): prove hosted Pi SDK sessions
```

## Black-box acceptance scenario

The final smoke test runs only packaged artifacts:

1. Create isolated cwd, agent directory, and Pi session directory.
2. Start `pi-tai-runtime` with a scripted faux provider, temporary `HOME`, and model-network refresh disabled.
3. Initialize generation 1 and assert reported Pi/Pi-Tai capabilities.
4. Create a session and retain its Pi session ID and file.
5. Prompt turn A and assert ordered start, text deltas, message end, agent end, and idle.
6. Shut down cleanly.
7. Start a new packaged worker with no repository cwd and a stripped runtime `PATH`.
8. Open the retained session file.
9. Prompt turn B; the faux response factory verifies turn A history is present.
10. Start a slow turn, cancel it, and assert aborted/interrupted semantics plus idle.
11. Start another slow turn, send SIGTERM, and assert bounded clean exit and valid JSONL history.
12. Assert every stdout line decoded, diagnostics contain no prompt text, and no paid/network request occurred.

## Acceptance evidence

H2 is complete only when the checkpoint records:

- protocol fixture and decoder tests;
- SDK integration test results;
- persistent session file inspection;
- replacement/subscription test results;
- cancellation and signal timings;
- packaged black-box smoke output;
- packaging comparison table and ADR 0005;
- startup/RSS/size measurements;
- unchanged terminal Pi-Tai checks.

Required commands will include:

```bash
npm run check
npm run smoke:isolated
just runtime-smoke
just runtime-package-compare
pi -ne -e . "<terminal regression prompt>"
```

## Risks and planned probes

| Risk | H2 probe or containment |
|---|---|
| Bun or SEA misses dynamic Guardian/native assets | Run Pi-Tai/Guardian load from copied packaged artifacts |
| Session replacement retains the old listener | Tag subscriptions and assert no event after replacement comes from the old session |
| Prompt handling blocks cancellation | Respond at Pi preflight and keep the command reader independent of the prompt task |
| Pi/extension logging corrupts stdout | Install output guards before importing runtime modules; parse every output line |
| Tests consume user auth or sessions | Set temporary `HOME`, cwd, `agentDir`, and session directory; assert all created files remain under the harness root |
| Faux model does not exercise tools | Script an `update_plan` tool call plus its follow-on assistant response after the text-only baseline, without shell/network side effects |
| Signal exit truncates session history | Abort, await bounded idle, dispose, then parse and reopen the session file |
| Packaged worker depends on repository files | Copy only declared artifacts to a fresh directory and run with stripped `PATH` |
| One-worker-per-session memory is excessive | Measure idle/active RSS and carry evidence to Gate H; do not hide it with pooling in H2 |
| Proof events accidentally become product API | Mark runtime protocol v1 as internal/provisional until Gate H |

## Deferred decisions

H2 deliberately leaves these for later review:

- final production event payloads and broker normalization;
- the installed Pi session directory and whether hosted sessions share terminal storage;
- real-provider credential migration and manager UX;
- universal macOS builds, signing, notarization, and updater integration;
- whether measured worker memory warrants pooling instead of one worker per loaded session.

No additional product decision is required before starting H2. The packaging choice is made from proof evidence and reviewed before H3.
