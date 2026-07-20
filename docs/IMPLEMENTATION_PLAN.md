# Pi-Tai Refresh Implementation Plan

## Working method

Each behavior phase follows red-green-refactor:

1. **Red:** add the smallest test that expresses the required behavior and verify it fails for the expected reason.
2. **Green:** implement the smallest coherent change that passes the new test.
3. **Refactor:** improve structure without changing behavior and keep the full suite green.
4. **Checkpoint:** create a reviewable Jujutsu commit with a Conventional Commit description.

Do not combine terminal refresh work and ACP frontend work in one checkpoint. Work stops after terminal acceptance until the user explicitly approves ACP development.

## Phase 0: product documentation

### Deliverables

- Formal product requirements.
- Terminal and ACP scope boundaries.
- Prioritized ACP feature matrix.
- Host, broker, desktop, and mobile architecture baseline.
- Red-green implementation sequence.

### Checkpoint

```text
docs: add refresh PRD and phased implementation plan
```

## Stage 1: refresh terminal Pi-Tai

The implementation-ready repository layout, plugin composition design, test boundaries, and checkpoint sequence are specified in [TERMINAL_PLUGIN_PLAN.md](TERMINAL_PLUGIN_PLAN.md). The phases below remain the product-level acceptance summary; where filenames or tactical sequencing differ, the terminal plan controls.

### Phase 1: establish the modern baseline

#### Red

- Add a package-load smoke test using only this distribution.
- Add tests that assert the expected extension and theme resources are discoverable.
- Add a test that starts a non-TUI session without ANSI polling.

#### Green

- Move imports from `@mariozechner/*` to `@earendil-works/*`.
- Declare current Pi core packages as peer dependencies.
- Add test and type-check scripts.
- Remove temporary README text and obsolete settings documentation that no longer describes the target architecture.
- Ensure test fixtures use in-memory settings and sessions where possible.

#### Refactor

- Introduce shared configuration parsing only when at least two extensions need it.
- Keep ACP packaging out of this phase.

#### Acceptance

- The package loads in terminal, print, and RPC contexts.
- Baseline tests pass without loading unrelated global extensions.

### Phase 2: replace task context with structured planning

#### Red

Add unit tests for:

- creating a goal and plan from a complete tool payload;
- rejecting more than one `in_progress` item;
- rejecting a direct `pending` to `completed` transition;
- replacing rather than merging plan state;
- reconstructing the latest state from the active branch;
- restoring different state after tree/branch navigation;
- producing a readable full-state tool result;
- preserving state through session resume data;
- omitting plans for simple work at the instruction level.

#### Green

- Add the `update_plan` tool.
- Store complete state in tool-result details.
- Reconstruct state only from the active branch.
- Add concise planning guidelines to the tool/system prompt.
- Add a terminal renderer and lightweight status only as progressive enhancement.
- Remove fenced `task-context` parsing and assistant-message scraping.

#### Refactor

- Separate schema validation, state reconstruction, transition validation, and rendering.
- Keep the serializable work-context representation independent of TUI components.

#### Acceptance

- A terminal Pi session can create, update, complete, resume, and branch a goal/plan correctly.
- Final assistant answers do not contain hidden tracker blocks.

### Phase 3: automatic session naming

#### Red

Add unit tests for:

- parsing `provider`, `model`, and `effort` independently;
- resolving the configured model through a fake model registry;
- passing the configured effort to the naming request;
- naming only after the first meaningful user request;
- not overwriting an existing manual name;
- naming only once by default;
- never using the active work model as an implicit fallback;
- using a deterministic heuristic when the configured title model is unavailable;
- trimming quotes, punctuation, excess whitespace, and excess words;
- calling `pi.setSessionName()` with the normalized title.

#### Green

- Add the session-title extension.
- Make the title model call injectable.
- Use no tools and a small output budget.
- Use configured Pi authentication for the specified provider/model.
- Add deterministic fallback naming.

#### Refactor

- Isolate model resolution from title normalization.
- Keep the naming prompt short and original to Pi-Tai.

#### Acceptance

- A real terminal session can use configured Luna provider/model/effort while the main work session continues using a different model.
- Naming failure does not interrupt the agent turn.

### Phase 4: replace modes with Approval Guardian

#### Red

Add integration tests for:

- loading Guardian exactly once;
- ordinary in-project actions following Guardian's configured review rules;
- covered actions failing closed when the reviewer is unavailable;
- private-data actions requiring explicit user authorization;
- the reviewer transcript containing the current goal and full plan;
- plan context being framed as evidence rather than authorization;
- non-interactive and RPC behavior requiring no TUI prompt;
- no old mode commands or mode prompt fragments remaining.

#### Green

- Add `pi-approval-guardian` as the Guardian implementation.
- Initially rely on readable plan tool calls/results in active branch context.
- If tests show context is insufficient, add a thin wrapper around a stable/upstream context-provider hook.
- Submit the public export/context-provider enhancement upstream if necessary.
- Remove the old mode registry, access policies, classifiers, prompts, commands, and runtime.

#### Refactor

- Keep Pi-Tai's Guardian integration limited to configuration and task-context adaptation.
- Do not duplicate Guardian's security implementation.

#### Acceptance

- There is one guarded automatic workflow.
- Guardian behavior is visible and fail-closed.
- The old `/mode`, `/review-mode`, and `/implement` commands are absent.

### Phase 5: make ANSI theming lifecycle-safe

#### Red

Add tests for:

- no terminal query or timer in RPC, print, or JSON mode;
- terminal query beginning only after TUI session start;
- theme selection from dark/light background values;
- polling cleanup during shutdown and reload;
- silent fallback when terminal queries are unsupported.

#### Green

- Guard the extension with `ctx.mode === "tui"`.
- Move resource startup to `session_start`.
- Make startup and cleanup idempotent.
- Preserve `ansi-dark` and `ansi-light`.

#### Refactor

- Inject terminal-query and scheduling functions for deterministic tests.
- Remove direct ANSI formatting from non-TUI status state.

#### Acceptance

- ANSI themes still follow the terminal palette in interactive Pi.
- No ANSI subprocess or timer is created in headless use.

### Phase 6: cleanup, licensing, and terminal release candidate

#### Red

Add repository assertions for:

- no imports or package references to old Mario packages;
- no files under `extensions/modes`;
- no copied Guardian prompt;
- no obsolete mode settings in documentation;
- required third-party license/notice files being present for redistributed dependencies;
- package tarball/Git package containing only intended resources.

#### Green

- Delete old mode and task-context implementation remnants.
- Remove obsolete mode attribution after its derived code is gone.
- Add/update third-party notices for retained dependencies.
- Rewrite README and settings documentation around the refreshed product.
- Document tagged Git installation and explicit upgrades.

#### Acceptance

- Type-check, unit tests, package checks, and isolated Pi smoke tests pass.
- The repository contains no generated dependency directories or machine-local paths.

### Phase 7: manual terminal acceptance gate

Stop implementation and provide a manual review checklist:

- install the candidate from its Git tag or local path;
- start a fresh terminal Pi session;
- verify ANSI dark/light behavior;
- run a simple task that should not create a plan;
- run a multi-stage task that should create and maintain a plan;
- confirm session naming uses Luna configuration;
- confirm the primary work model is unchanged;
- exercise a Guardian allow, denial, and unavailable-reviewer failure;
- resume the session and inspect restored name and plan;
- branch within Pi and verify plan reconstruction.

**Do not begin ACP implementation without explicit user approval after this review.**

## Stage 2: host-owned Pi sessions and Zed continuity

This stage begins only after explicit approval at the terminal acceptance gate. The target architecture is defined in [HOST_ARCHITECTURE.md](HOST_ARCHITECTURE.md).

### Phase 8: architecture and protocol proof

This phase closes high-risk boundaries before product implementation.

#### Red

Create executable proof tests for:

- a Tauri tray process remaining alive after its React/Vite window closes;
- the desktop manager starting and reconnecting to the tray Host;
- a bundled TypeScript helper loading Pi through the SDK in-process;
- ordered local IPC across Rust and TypeScript boundaries;
- a client disconnect not intentionally cancelling an active Pi turn;
- process interruption producing an explicit interrupted state;
- replaying a completed session after Host restart;
- Zed launching a minimal ACP shim;
- Zed rendering independently authored native-plan fixtures.

#### Research questions

- Can a crashed desktop WebView be recreated without terminating the tray process on supported platforms?
- How should the TypeScript Pi helper be packaged without requiring a user-managed Node installation?
- Which ACP plan variant does Zed's Codex integration currently emit and render?
- How are plan IDs, priorities, and complete replacement represented?
- Which tool kinds and content variants produce the clearest Zed presentation?
- Which current ACP capabilities are advertised by Zed?

#### Green

- Build disposable Host, runtime-helper, IPC, and ACP-shim spikes.
- Read the current ACP specification and SDK schemas.
- Inspect the open-source Codex ACP adapter and relevant tests at a pinned revision.
- Record fixture-based conclusions without copying implementation code.
- Write ADRs for process lifecycle, helper packaging, IPC framing, event ordering, and recovery.

#### Acceptance

- One prompt traverses a test client through the Host into an in-process Pi SDK session and streams back.
- Disconnecting the client leaves the Host and runtime healthy.
- Restarting after a forced Host failure recovers history and reports an interrupted turn honestly.
- A fixture suite describes the exact plan and tool updates Pi-Tai ACP will emit.
- No generic downstream ACP-agent layer is required.

### Phase 9: durable single-session Host

#### Red

Add tests for:

- serialized session commands;
- monotonic event sequences and revisions;
- durable command acknowledgement;
- operation-ID deduplication;
- one active prompt turn;
- reconnect from an event cursor;
- helper crash and restart state transitions;
- Host restart with load/resume or non-resumable recovery;
- tray quit warnings while a turn is active.

#### Green

- Add the Pi-Tai Host tray application.
- Add one per-session broker actor.
- Add the bundled TypeScript Pi runtime helper.
- Add SQLite events, projections, and snapshots.
- Add authenticated local IPC.
- Add a diagnostic CLI for create, observe, prompt, cancel, and replay.

#### Acceptance

- Start a Pi session, detach the diagnostic client, reconnect, and replay its ordered timeline.
- Retrying an acknowledged operation does not duplicate its Pi-side effect.
- Closing the client does not stop a healthy turn.
- Host or helper failure produces a capability-accurate recovered, interrupted, or non-resumable state.

### Phase 10: thin ACP shim and stock Zed continuity

#### Red

- Initialization and capability-negotiation tests.
- Host-unavailable and version-mismatch tests.
- New, list, load, resume, close, prompt, and cancellation tests.
- Zed attachment/disconnection tests.
- Replay-without-duplicate-message tests.
- Authentication-required tests.
- Graceful shutdown and malformed-message tests.

#### Green

- Add `pi-tai-acp` using the official ACP SDK.
- Connect it to Host local IPC rather than creating Pi sessions itself.
- Virtualize supported session capabilities from the broker event store.
- Keep durable state and Pi process ownership out of the shim.

#### Acceptance

- Start in Zed, disconnect Zed while a turn runs, and restore the same Host-owned session.
- A shim crash does not intentionally terminate Pi.
- A session created outside Zed can be discovered and loaded through the supported Zed flow.

### Phase 11: rich messages and tools

#### Red

Add translation tests for:

- assistant text and thought chunks with stable message IDs;
- read, search, execute, edit, delete, move, fetch, and generic tool kinds;
- concise tool titles;
- tool status transitions;
- file and line locations;
- structured diffs;
- terminal output;
- parallel tool calls without cross-contamination.

#### Green

Implement a registry-based Host-event-to-ACP translation layer rather than one large event switch.

### Phase 12: native plans and live titles

#### Red

- Plan replacement and progress tests using Zed-tested fixtures.
- Capability fallback tests.
- Session title update tests.
- Session history title tests.
- broker-originated plan-update revision and controller tests.
- model-visible notification tests for externally changed plans.

#### Green

- Project Pi-Tai work context into Host events and native ACP plans.
- Forward Pi session-name changes as ACP session metadata updates.
- Add the broker work-context storage adapter.
- Define controller-authoritative external plan replacement without silently hiding the change from Pi.

### Phase 13: model controls, commands, sessions, and Guardian presentation

#### Red

- Main model and thought-level selector tests.
- Dynamic config update tests.
- command/skill advertisement tests.
- paginated list/load/resume/close tests.
- usage/cost update tests.
- ACP permission request and Guardian association tests.
- controller epoch and stale-revision rejection tests.

#### Green

Implement only the P0/P1 items accepted from [ACP_SCOPE.md](ACP_SCOPE.md).

### Gate B: Host and Zed manual acceptance

Stop and verify:

- the tray Host starts directly and from the desktop manager spike;
- closing Zed or the desktop window leaves a healthy turn running;
- session history recovers after a controlled Host restart;
- Zed can discover and restore Host-owned sessions;
- plans, titles, tools, diffs, locations, terminal output, models, and Guardian are useful in Zed.

## Stage 3: desktop and remote companion clients

### Phase 14: minimal desktop manager

Use Tauri with React and Vite.

#### Red

- Host launch/reconnect/version-handshake tests.
- Configuration validation tests.
- Host, Pi auth, title model, and Guardian readiness projection tests.
- Active-session status tests.
- UI-window closure tests proving the separate Host continues.

#### Green

- Add configuration and readiness views.
- Add Host startup and launch-at-login management.
- Add Zed setup assistance.
- Add basic session title, workspace, state, clients, controller, and last-activity status.
- Add redacted diagnostics.

Prompting, plan editing, transcript review, and archiving remain out of this phase.

### Phase 15: paired mobile observer

Use Tauri Mobile with React and Vite.

#### Red

- Tailscale/local-only binding tests.
- Pairing, device authentication, and revocation tests.
- Snapshot and cursor replay tests.
- Offline cache tests.
- Version negotiation tests.

#### Green

- Add a versioned product API; do not expose raw ACP to mobile.
- Add a shared API client and generated/mapped types.
- Add host list, session inbox, timeline, status, plan, and tool views.
- Add durable reconnect and local cache behavior.

### Phase 16: mobile control

#### Red

- One-controller lease and epoch tests.
- Competing takeover tests.
- stale revision and duplicate operation tests.
- prompt, cancellation, plan-edit, question, and permission-resolution tests.
- local-only draft tests while disconnected or observing.

#### Green

- Add explicit control handoff.
- Add prompt and cancellation.
- Add controller-authoritative plan editing.
- Add questions and Guardian-compatible permission presentation.

### Phase 17: remote creation, workspaces, and review

- Add allowed repository configuration.
- Default mobile-created Git sessions to managed worktrees.
- Add attached-workspace writer exclusion.
- Add changed-file and paginated diff projections.
- Add Zed discovery of mobile-created sessions.
- Add notifications only after durable observer/control behavior is accepted.

## Deferred features

The following do not block the initial Host/Zed release:

- generic downstream ACP agents;
- Pi tree navigation;
- audio prompts;
- duplicate Zed completion/attention notifications;
- client filesystem delegation;
- client terminal delegation;
- session fork;
- MCP transports;
- provider configuration;
- elicitation;
- document synchronization;
- Next Edit Suggestions;
- T3-specific ACP extension methods;
- transparent in-flight continuation after complete Host-process failure;
- remote visibility for every standalone terminal Pi session.
