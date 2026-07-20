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
- Red-green implementation sequence.

### Checkpoint

```text
docs: add refresh PRD and phased implementation plan
```

## Stage 1: refresh terminal Pi-Tai

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

## Stage 2: first-party ACP frontend

### Phase 8: investigate ACP client behavior and Codex plan presentation

This is research, not implementation.

#### Questions

- Which ACP plan variant does Zed's Codex integration currently emit and render?
- Does Zed prefer stable `plan` updates or capability-gated `plan_update` operations?
- How are plan IDs, priorities, and full replacement represented?
- Which tool kinds and content variants produce the clearest Zed presentation?
- How does Zed display terminal content, structured diffs, locations, thoughts, usage, and permission requests?
- Which current ACP capabilities are advertised by Zed?

#### Method

- Read the current ACP specification and SDK schemas.
- Inspect the open-source Codex ACP adapter and relevant tests at a pinned revision.
- Build protocol fixtures from documented messages rather than copying implementation code.
- Record conclusions and compatibility behavior in an ACP translation design document.

#### Acceptance

- A fixture suite describes the exact plan and tool updates Pi-Tai ACP will emit.
- Stable and experimental behavior is capability-gated.

### Phase 9: ACP protocol foundation

#### Red

- Initialization negotiation tests.
- New-session lifecycle tests.
- Prompt streaming and cancellation tests.
- Authentication-required tests.
- Graceful shutdown and malformed-message tests.

#### Green

- Add `pi-tai-acp` using the official ACP SDK.
- Create Pi sessions in-process through Pi's runtime SDK.
- Load standard Pi and Pi-Tai resources.

### Phase 10: rich messages and tools

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

Implement a registry-based translation layer rather than one large event switch.

### Phase 11: native plans and live titles

#### Red

- Plan replacement and progress tests using Codex-compatible/Zed-tested fixtures.
- Capability fallback tests.
- Session title update tests.
- Session history title tests.

#### Green

- Translate Pi-Tai work context into native ACP plans.
- Forward Pi session-name changes as `session_info_update`.

### Phase 12: model controls, commands, sessions, and Guardian presentation

#### Red

- Main model and thought-level selector tests.
- Dynamic config update tests.
- command/skill advertisement tests.
- list/load/resume/close/delete session tests.
- usage/cost update tests.
- ACP permission request and Guardian association tests.

#### Green

Implement only the P0/P1 items accepted from [ACP_SCOPE.md](ACP_SCOPE.md).

## Deferred features

The following do not block the initial ACP release:

- Pi tree navigation;
- audio prompts;
- duplicate completion/attention notifications;
- client filesystem delegation;
- client terminal delegation;
- session fork;
- MCP transports;
- provider configuration;
- elicitation;
- document synchronization;
- Next Edit Suggestions;
- T3-specific ACP extension methods.
