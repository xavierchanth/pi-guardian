# Pi-Tai Refresh Product Requirements

## Status

Draft for review.

This document defines the intended shape of the Pi-Tai refresh. Implementation is split into two product stages:

1. refresh the Pi-Tai terminal distribution;
2. after manual terminal acceptance, build a separate Pi-Tai ACP frontend.

The ACP stage must not begin until the refreshed terminal experience has been manually reviewed and accepted.

## Product summary

Pi-Tai is a focused Pi distribution that adds:

- guarded automatic tool execution using Approval Guardian;
- a persistent goal and Codex-style execution plan;
- inexpensive automatic session naming with an independently configured model;
- ANSI-derived themes for Pi's terminal interface;
- later, a first-party ACP frontend optimized for Zed and reusable by other ACP clients.

Pi-Tai should extend Pi without introducing its own read, edit, plan, or permission modes.

## Goals

### Terminal refresh

- Replace the current mode hierarchy with one guarded automatic workflow.
- Replace the fenced `task-context` protocol with a structured planning tool.
- Preserve a concise goal and optional task plan across session resume and branch changes.
- Integrate `pi-approval-guardian` without copying its policy implementation.
- Supply the current goal and plan to Guardian as review evidence.
- Automatically name new sessions using a separately configured provider, model, and effort.
- Keep the ANSI terminal themes and dynamic terminal palette detection.
- Remove obsolete permission-plugin and copied Codex Guardian code and notices once no derived code remains.
- Install reproducible releases directly from Git tags.

### ACP frontend

- Build a new ACP frontend from the official ACP SDK and Pi SDK rather than deriving it from `pi-acp`.
- Optimize semantic rendering for Zed while remaining protocol-correct for other ACP clients.
- Reuse the same Pi-Tai extensions and session behavior as terminal Pi.
- Surface native ACP plans, rich tool calls, diffs, locations, model controls, titles, and usage.
- Keep the architecture suitable for a possible future T3 Code client.

## Non-goals

- Pi tree navigation in the ACP frontend.
- Audio prompts.
- Replacing Zed's existing completion and attention notifications.
- Restoring plan, read, edit, or permission modes.
- Maintaining Pi-Tai's current permission classifier after Guardian integration.
- Copying or independently maintaining Approval Guardian's policy, path rules, reviewer lifecycle, or Codex-derived prompt.
- Forking or copying the current `pi-acp` implementation.
- Publishing to the npm registry as a requirement.
- Implementing MCP, client filesystem delegation, client terminal delegation, NES, or document synchronization in the first ACP release.

## Users and primary workflows

### Terminal Pi user

1. Installs a tagged Pi-Tai release through `pi install`.
2. Starts Pi normally.
3. Uses normal Pi tools without selecting an access mode.
4. Sees Guardian automatically review covered actions.
5. Sees a lightweight goal and plan for non-trivial work.
6. Receives an automatically generated session name.
7. Uses ANSI-derived colors in the terminal.

### Zed user

1. Installs the same tagged repository as a Pi package and as an ACP executable.
2. Selects `pi-tai-acp` as an external agent in Zed.
3. Selects the main working model and effort independently from the title-naming model.
4. Sees native plans, useful tool titles, structured diffs, terminal output, and file locations.
5. Resumes named Pi sessions from Zed.

## Functional requirements

### FR-1: guarded automatic workflow

- Pi-Tai must expose no custom access-mode hierarchy.
- Pi's normal tools remain available.
- `pi-approval-guardian` decides whether covered operations may execute.
- Covered actions fail closed when Guardian cannot produce a valid decision.
- ACP and non-interactive operation must not depend on a TUI-only bypass or prompt.
- Private-data access must continue to require explicit user authorization according to Guardian policy.

### FR-2: goal and execution plan

Pi-Tai must register a structured planning tool with a complete-state update shape:

```ts
{
  goal?: string;
  explanation?: string;
  plan: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
    priority?: "high" | "medium" | "low";
  }>;
}
```

Requirements:

- The goal is one concise north-star outcome.
- Plans are optional for simple work and expected for non-trivial, ambiguous, or multi-stage work.
- Every call replaces the full goal and plan state.
- At most one item may be `in_progress`.
- No item may move directly from `pending` to `completed` without first becoming `in_progress`.
- The plan must be updated when scope or sequencing changes materially.
- The plan must not remain stale while implementation proceeds.
- State must reconstruct correctly from the active Pi session branch.
- State must survive resume and compaction.
- The tool result must contain a readable complete snapshot, not only opaque details.
- Terminal-specific rendering may enhance the tool but cannot be required for correctness.

### FR-3: Guardian task context

- Guardian must receive the current goal and plan as untrusted review evidence.
- The planned operation and explicit user authorization remain authoritative; a broad goal does not authorize an unrelated risky action.
- The first implementation must test whether the plan tool call and readable result already provide sufficient reviewer context.
- Preferred integration is an upstream `contextProvider` option and stable programmatic export from `pi-approval-guardian`.
- If an upstream extension point is unavailable, Pi-Tai may carry a minimal adapter patch, but must not duplicate Guardian policy code.

### FR-4: automatic session naming

The title namer must have an independent configuration:

```json
{
  "piTai": {
    "sessionTitle": {
      "provider": "provider-id",
      "model": "luna-model-id",
      "effort": "minimal",
      "maxWords": 6,
      "fallback": "heuristic"
    }
  }
}
```

Requirements:

- `provider`, `model`, and `effort` are independently configurable.
- `effort` uses Pi thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
- The exact model must resolve through Pi's model registry and use Pi's configured authentication.
- The naming request uses no tools and a small output budget.
- Naming occurs after the first meaningful user request.
- A manually named session must not be overwritten.
- Automatic naming occurs once by default.
- The active working model must never be used as an implicit fallback.
- Default fallback is a deterministic title derived from the first prompt.
- The generated title is persisted through `pi.setSessionName()`.

The exact Luna provider and model IDs will be supplied in user configuration rather than hard-coded.

### FR-5: ANSI terminal theme

- Keep `ansi-dark` and `ansi-light` themes.
- Dynamic palette detection runs only in Pi's TUI mode.
- Palette polling starts during session lifecycle, not during extension factory evaluation.
- Polling and child processes are cleaned up on session shutdown.
- RPC, print, JSON, and ACP operation must not access `/dev/tty` or start palette polling.
- ACP clients retain control of their own visual theme.

### FR-6: installation and releases

Pi package installation must support tagged Git releases:

```bash
pi install git:github.com/xavierchanth/pi-tai@v0.1.0
```

Project-local installation must also work:

```bash
pi install -l git:github.com/xavierchanth/pi-tai@v0.1.0
```

Requirements:

- Releases use semantic Git tags.
- Tagged Pi installs remain pinned until explicitly moved to another tag.
- npm registry publication is optional.
- The future ACP executable may be installed from the same Git tag using a Git-backed global package install.

### FR-7: first-party ACP frontend

The ACP frontend must:

- use `@agentclientprotocol/sdk` for protocol transport and types;
- use Pi's SDK in-process;
- negotiate capabilities instead of assuming a specific client;
- load normal Pi settings, authentication, models, context, skills, prompts, and Pi-Tai extensions;
- preserve Pi session compatibility between terminal and ACP use;
- emit semantically rich ACP updates rather than flattening events to chat text;
- use Zed Codex ACP behavior as research material for native plan support, without copying its implementation;
- omit Pi tree navigation and audio prompting;
- rely on Zed's existing thread completion and attention notifications.

Detailed ACP scope is maintained in [ACP_SCOPE.md](ACP_SCOPE.md).

## Configuration principles

- Pi-Tai-specific settings live under one `piTai` namespace where Pi settings permit it.
- Model references use separate `provider` and `model` fields.
- No feature silently falls back to the expensive active work model.
- Invalid optional configuration warns and degrades safely.
- Security configuration fails closed where Guardian requires it.
- Project-local configuration is honored only for trusted projects.

## Licensing requirements

- Pi-Tai's original code remains MIT-licensed.
- Remove `extensions/modes/LICENSE.md` only after all code derived from the old permissions plugin and copied Codex Guardian prompt has been removed.
- Preserve `pi-approval-guardian` license and notice files when it is bundled or redistributed.
- A wrapper around Guardian does not copy its Apache-licensed policy into Pi-Tai source.
- The new ACP frontend must not copy source from `pi-acp`; therefore it does not inherit `pi-acp` attribution.
- Preserve the Apache-2.0 license supplied with the official ACP SDK dependency.
- Maintain a concise third-party notices file for redistributed dependencies where required.

## Quality requirements

- Development follows red-green-refactor at behavior boundaries.
- Every new state transition or protocol translation begins with a failing test.
- Unit tests must not call paid models.
- Model calls use injectable fakes in tests.
- Session tests cover active-branch reconstruction, resume, and lifecycle reset.
- ACP tests use an in-memory fake client connection before Zed smoke testing.
- No generated dependencies, `node_modules`, secrets, or machine-local paths are committed.

## Release gates

### Gate A: terminal Pi-Tai acceptance

Before ACP implementation begins:

- old modes are removed;
- planning works in terminal Pi;
- session naming works with a configured fake and real title model;
- Guardian receives task context and gates actions;
- ANSI themes work in TUI and remain dormant outside TUI;
- automated tests pass;
- the user manually reviews the terminal experience.

Work stops at this gate until explicit approval.

### Gate B: ACP alpha acceptance

- Pi-Tai ACP starts from Zed.
- new and existing sessions work.
- model and effort selectors work.
- plans render through Zed's native plan support.
- titles update live.
- tool calls, diffs, locations, and terminal output are readable.
- Guardian decisions remain safe and understandable.

## Open decisions

- Exact public name of the planning tool: `update_plan` is the current preference.
- Exact Luna provider/model IDs for the user's configuration.
- Whether priorities should be required by the planning tool or default to `medium`.
- Whether Guardian accepts an upstream context-provider contribution.
- Whether the repository remains a single package through the terminal refresh or becomes a workspace before ACP development.
- Whether the ACP executable is installed globally from Git or through a future ACP Registry entry.
