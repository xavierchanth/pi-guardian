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

**Implementation status:** complete and manually accepted for progression to Stage 2; session-title tuning remains an independent follow-up if needed.

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

- every agent-generated `bash` call reaching model review;
- deterministic allow/review/deny classification for built-in file tools;
- Git-ignored, likely-secret, VCS, Pi credential, and Pi session targets reaching review;
- traversal and symlink escapes being blocked;
- independent risk/authorization scoring with routine low/medium autonomy;
- every non-allow result returning a tool failure without user interruption or approval requests;
- invalid, timed-out, cancelled, and failed reviews failing closed without approval fallback;
- local evaluation records retaining non-allow review inputs, outcomes, and actions;
- no old mode commands or mode prompt fragments remaining.

#### Green

- Add the local risk/authorization policy, isolated Codex reviewer, path classifier, and tool hook.
- Route `openai-codex/codex-auto-review` through Pi's existing Codex OAuth runtime.
- Retain non-allow review records locally without interrupting the agent if recording fails.
- Keep direct user shell and unknown custom tools outside the extension's scope.
- Remove the old mode registry, access policies, classifiers, prompts, commands, and runtime.

#### Refactor

- Keep the reviewer autonomy-first, risk-aware, and explicit that network access is not inherently severe.
- Make autonomous allow-or-deny decisions and never ask the user to approve a blocked action.
- Do not add command classifiers, allowlists, persistent bypasses, permission modes, or Guardian configuration.

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
- no legacy Guardian policy or prompt remnants;
- no obsolete mode settings in documentation;
- package tarball/Git package containing only intended resources.

#### Green

- Delete old mode and task-context implementation remnants.
- Remove stale references to retired implementations and dependencies.
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

**Implementation status:** H0 workspace/protocol contracts, H1 Tauri Host Agent lifecycle, and H2 Pi SDK runtime-worker proofs complete; H3 Host-to-worker supervision is next.

The decision-complete, proof-first execution plan is [STAGE2_HOST_IMPLEMENTATION_PLAN.md](STAGE2_HOST_IMPLEMENTATION_PLAN.md). The target architecture is defined in [HOST_ARCHITECTURE.md](HOST_ARCHITECTURE.md).

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
- the official SDK v2 client launching a minimal ACP v2 shim;
- a v2-capable Zed build launching the shim and rendering independently authored item-plan fixtures when available.

#### Research questions

- Can a crashed desktop WebView be recreated without terminating the tray process on supported platforms?
- How should the TypeScript Pi helper be packaged without requiring a user-managed Node installation?
- Which Zed release/preview channel negotiates ACP v2, and how is draft support enabled?
- Does Zed render stable v2 `plan_update` item plans keyed by `planId` as specified?
- Which v2 tool, structured-diff, and Agent-owned terminal updates produce the clearest Zed presentation?
- Which ACP v2 capabilities and extension flags does the selected Zed build advertise?
- Which matched official TypeScript SDK and ACP v2 schema alpha should be pinned for H5?

#### Green

- Build disposable Host, runtime-helper, IPC, and ACP-shim spikes.
- Read the ACP v2 draft specification, migration guide, RFDs, and official SDK experimental-v2 API.
- Pin the exact SDK package, schema alpha, checksum, and upstream revision.
- Exercise public ACP v2 behavior against independently authored fixtures, including prompt acceptance, idle/background updates, resume replay, three-state patches, JSON-RPC batches, item plans, tools, terminals, diffs, permissions, and config options.
- Record fixture-based conclusions as product-owned behavioral contracts; never persist generated ACP structs.
- Write ADRs for process lifecycle, helper packaging, IPC framing, event ordering, and recovery.

#### Acceptance

- One prompt traverses a test client through the Host into an in-process Pi SDK session and streams back.
- Disconnecting the client leaves the Host and runtime healthy.
- Restarting after a forced Host failure recovers history and reports an interrupted turn honestly.
- A fixture suite describes the exact ACP v2 lifecycle, item-plan, message, tool, terminal, diff, and permission updates Pi-Tai emits.
- Prompt acceptance is demonstrably separate from foreground completion, and background updates survive idle state.
- No generic downstream ACP-agent layer or ACP v1 fallback is required.

### Phase 9: durable single-session Host

#### Red

Add tests for:

- serialized session commands;
- monotonic event sequences and revisions;
- durable command acknowledgement;
- operation-ID deduplication;
- one active foreground operation represented independently from runtime health and attachment state;
- stable semantic item IDs across live delivery and replay;
- reconnect from an event cursor and replay through a high-water barrier;
- helper crash and restart state transitions;
- Host restart with runtime reopen/resume or non-resumable recovery;
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

### Phase 10: thin ACP v2 shim and Zed continuity

#### Red

- Protocol-v2 initialization with required `info`, exact capability objects, v1 mismatch, and draft configuration tests.
- JSON-RPC single/batch, Host-unavailable, auth-required, and version-mismatch tests.
- Complete baseline `session/new`, list, resume, close, prompt, cancel, and update tests; no `session/load`.
- Prompt acceptance response queued before canonical `user_message` and running state.
- Idle completion, requires-action transitions, background updates while idle, and second-prompt rejection.
- Zed attachment/disconnection versus explicit close tests.
- Resume without replay and resume-from-start without duplicate or interleaved live messages.
- Three-state patch, unknown-variant fallback, graceful shutdown, and malformed-known-variant tests.

#### Green

- Add `pi-tai-acp` using the exact-pinned `@agentclientprotocol/sdk/experimental/v2` entry point.
- Connect it to Host local IPC rather than creating Pi sessions or canonical item IDs itself.
- Advertise the session capability only when the complete ACP v2 baseline is available.
- Keep durable state, generated ACP types, and Pi process ownership out of the shim.
- Do not add an ACP v1 compatibility surface.

#### Acceptance

- Start in a v2-capable Zed build, disconnect Zed while foreground work runs, and resume the same Host-owned session with full replay.
- A shim crash detaches without terminating Pi; explicit `session/close` cancels foreground work and releases activation.
- A session created outside Zed can be discovered and resumed through the supported v2 flow.
- If Zed v2 is not yet available, the official SDK v2 client proves the flow and the Zed smoke test remains an explicit external gate.

### Phase 11: rich messages and tools

#### Red

Add translation tests for:

- user, assistant, and thought whole-message upserts and chunks with stable message IDs;
- message replacement, explicit clear, and append ordering;
- read, search, execute, edit, delete, move, fetch, and generic tool kinds;
- first-seen `tool_call_update`, concise titles, patch clears, status transitions, and content chunks;
- file and line locations;
- authoritative structured file operations plus optional `git_patch` text;
- Agent-owned terminal snapshots, independently base64-decoded byte chunks, and exit status;
- parallel tool calls and terminals without cross-contamination.

#### Green

Implement a registry-based Host-event-to-ACP translation layer rather than one large event switch.

### Phase 12: native plans and live titles

#### Red

- Complete item-plan replacement and progress tests keyed by one stable `planId` using Zed-tested fixtures.
- Explicit priority/defaulting tests and documentation that Pi-Tai does not initially emit ACP's optional cancelled plan-entry state.
- Session title update tests.
- Session history title tests.
- broker-originated plan-update revision and active-client attribution tests.
- model-visible notification tests for externally changed plans.

#### Green

- Project Pi-Tai work context into Host events and ACP v2 `plan_update` item plans.
- Forward Pi session-name changes as ACP session metadata updates.
- Add the broker work-context storage adapter.
- Define Host-authoritative external plan replacement with active-client attribution without silently hiding the change from Pi.

### Phase 13: model controls, commands, sessions, and Guardian presentation

#### Red

- Main model and thought-level config-option tests using `configId` and category.
- Complete config replacement and dependent-option update tests.
- command/skill advertisement tests.
- paginated list, resume-with/without-replay, and close tests.
- usage/cost update tests.
- ACP permission request and Guardian association tests.
- immediate active-client transfer, conflict, and stale-revision rejection tests.

#### Green

Implement only the P0/P1 items accepted from [ACP_SCOPE.md](ACP_SCOPE.md).

### Gate B: Host and Zed manual acceptance

Stop and verify:

- the tray Host starts directly and from the desktop manager spike;
- closing Zed or the desktop window leaves a healthy turn running;
- session history recovers after a controlled Host restart;
- a v2-capable Zed can discover and resume Host-owned sessions;
- item plans, titles, upserted tools, structured diffs, locations, Agent-owned terminal output, config options, and Guardian are useful in Zed.

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
- Add basic session title, workspace, state, clients, active-client attribution, and last-activity status.
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

- Immediate cross-client control-transfer and epoch tests.
- Competing same-revision command tests.
- stale revision and duplicate operation tests.
- prompt, cancellation, plan-edit, question, and permission-resolution tests.
- local-only draft tests while disconnected or observing.

#### Green

- Add immediate Host-arbitrated control transfer with no takeover confirmation policy.
- Add prompt and cancellation.
- Add active-client-attributed plan editing.
- Add questions and Guardian-compatible permission presentation.

### Phase 17: remote creation, workspaces, and review

Detailed terminal/backend slices and ownership contracts: [WORKSPACE_CAPABILITIES_PLAN.md](WORKSPACE_CAPABILITIES_PLAN.md).

- Add allowed repository configuration.
- Add capability-gated JJ-workspace and Git-worktree backends behind a shared workspace port.
- Prefer JJ for mobile- or Host-created sessions when the repository and executable support it; fall back to Git worktrees only when JJ is unavailable before creation begins.
- Model direct create-and-enter as a successor Pi session/runtime in the managed workspace while preserving the stable broker session ID; model delegated work as a separately identified child broker/Pi session with parent messaging and report semantics.
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
- ACP v1 Client filesystem delegation, which is removed in ACP v2;
- ACP v1 Client terminal execution/control, which is removed in ACP v2;
- session fork;
- MCP transports;
- provider configuration;
- elicitation;
- document synchronization;
- Next Edit Suggestions;
- T3-specific ACP extension methods;
- transparent in-flight continuation after complete Host-process failure;
- remote visibility for every standalone terminal Pi session.
