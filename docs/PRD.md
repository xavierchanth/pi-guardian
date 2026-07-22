# Pi-Tai Refresh Product Requirements

## Status

Draft for review.

This document defines the intended shape of the Pi-Tai refresh. Implementation is split into three product stages:

1. refresh the standalone Pi-Tai terminal distribution;
2. after manual terminal acceptance, build Pi-Tai Host and its Zed ACP adapter;
3. add desktop management and remote companion clients around host-owned sessions.

Host, ACP, and companion implementation must not begin until the refreshed terminal experience has been manually reviewed and accepted. The planned multi-client architecture is detailed in [HOST_ARCHITECTURE.md](HOST_ARCHITECTURE.md).

## Product summary

Pi-Tai is a focused Pi distribution that adds:

- guarded automatic tool execution using Approval Guardian;
- a persistent goal and Codex-style execution plan;
- inexpensive automatic session naming with an independently configured model;
- ANSI-derived themes for Pi's terminal interface;
- later, a tray-resident Pi-Tai Host that owns durable multi-client Pi sessions;
- a thin first-party ACP adapter optimized for Zed;
- desktop and mobile Tauri clients using React and Vite.

Pi-Tai should extend Pi without introducing its own read, edit, plan, or permission modes. Pi is the only initial hosted runtime; generic downstream ACP-agent brokering is not required.

## Goals

### Terminal refresh

The detailed terminal design and checkpoint sequence are defined in [TERMINAL_PLUGIN_PLAN.md](TERMINAL_PLUGIN_PLAN.md).

- Replace the current mode hierarchy with one guarded automatic workflow.
- Replace the fenced `task-context` protocol with a structured planning tool.
- Preserve a concise goal and optional task plan across session resume and branch changes.
- Review every agent-generated `bash` action with an isolated Codex auto-review session.
- Restrict mutating built-in file tools to canonical workspace and OS temporary roots while allowing read-only inspection of Pi and global skill directories.
- Automatically name new sessions using a separately configured provider, model, and effort.
- Keep the ANSI terminal themes and dynamic terminal palette detection.
- Remove obsolete permission-plugin and external Guardian integration artifacts.
- Install reproducible releases directly from Git tags.

### Host and ACP frontend

- Make one broker-owned Pi session authoritative across Zed and future companion clients.
- Package Pi-Tai Host as a tray-resident Tauri application rather than an installed daemon initially.
- Keep the configuration/status desktop manager independent from the session-owning Host process.
- Run Pi through its SDK in a self-contained Bun runtime-worker executable supervised by the Host.
- Build a thin, product-owned ACP v2 draft shim against the official SDK's exact-pinned experimental v2 contracts.
- Let Zed disconnect without intentionally terminating healthy Host-owned foreground work; treat explicit `session/close` as cancellation and activation release.
- Optimize semantic rendering for Zed while remaining protocol-correct for other ACP clients.
- Reuse the same Pi-Tai work-context, naming, Guardian, and session behavior as terminal Pi.
- Surface ACP v2 item plans, upserted tool calls, structured diffs, Agent-owned terminals, locations, config options, titles, and usage.
- Keep the product API suitable for mobile, web, terminal, chat, and possible future T3 clients.

## Non-goals

- Pi tree navigation in the ACP frontend.
- Audio prompts.
- Replacing Zed's existing completion and attention notifications.
- Restoring plan, read, edit, or permission modes.
- Maintaining Pi-Tai's current permission classifier after Guardian integration.
- Maintaining configurable command taxonomies or compatibility layers outside Pi-Tai's concise risk/authorization policy.
- Adopting an existing ACP frontend architecture instead of the Host-owned session design.
- Publishing to the npm registry as a requirement.
- Implementing MCP, NES, or document synchronization in the first ACP release. ACP v1 Client filesystem and terminal execution surfaces are not implemented because ACP v2 removes them.
- Supporting arbitrary downstream ACP agents in the initial Host.
- Sharing or writing Zed's private thread database.
- Guaranteeing survival of an in-flight tool operation after the complete Host process crashes.
- Making every standalone terminal Pi session remotely observable.
- Using React Native for the planned Tauri mobile application.

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

1. Starts the Pi-Tai Host tray application directly or through Pi-Tai Desktop.
2. Selects `pi-tai-acp` as an external agent in Zed.
3. Creates or attaches to a host-owned Pi session.
4. Selects the main working model and effort independently from the title-naming model.
5. Sees native plans, useful tool titles, structured diffs, terminal output, and file locations.
6. Leaves Zed without intentionally terminating foreground work, then resumes the same named session later with ACP v2 replay when needed.

### Desktop manager user

1. Opens a Tauri desktop application using React and Vite.
2. Configures Pi-Tai, Guardian, title naming, Zed integration, and Host startup.
3. Sees Host health and basic active-session status.
4. Closes the manager while the separately running Host tray process continues.

### Future mobile user

1. Pairs a Tauri Mobile application with the Host over Tailscale.
2. Observes the same broker-owned sessions visible in Zed.
3. Later prompts, cancels, edits plans, and resolves interactions through immediate Host-arbitrated control transfer.
4. Starts a host-owned session remotely and later discovers it from Zed.

## Functional requirements

### FR-1: guarded automatic workflow

- Pi-Tai must expose no custom access-mode hierarchy.
- Pi's normal tools remain available.
- `openai-codex/codex-auto-review` independently scores risk and authorization for every agent-generated `bash` action.
- Low/medium-risk task work normally proceeds; high-risk work requires meaningful authorization and narrow scope; critical work never executes automatically.
- Every non-allow result returns a failed tool result so the agent can continue without interrupting or asking the user for approval.
- Invalid, timed-out, cancelled, and failed reviews fail closed without an approval fallback.
- Non-allow review inputs, decisions/failures, and actions are retained locally for evaluation.
- Built-in file tools automatically access canonical unignored workspace targets and safe temporary/read-only roots.
- Git-ignored direct targets, likely secret paths, VCS metadata, Pi credentials/model configuration, and Pi session history receive Guardian review.
- Pi-state writes, traversal, symlink escapes, and other outside-boundary file operations are blocked; reviewed `bash` is the escalation path.

### FR-2: goal and execution plan

Pi-Tai must register a structured planning tool with a complete-state update shape:

```ts
{
  goal: string;
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
- Interactive TUI sessions show a responsive two-line widget with the goal on the first line and plan progress/current step on the second.
- Compact tool results expand to the complete checklist, and `/plan-status` provides a read-only full-plan view.

### FR-3: Guardian review context

- Guardian receives an exact structured action, deterministic path evidence when applicable, and a bounded role-preserving transcript.
- Only user-role content supplies authorization; assistant text, tool output, repository contents, path evidence, and work context remain evidence.
- Network risk depends on destination, payload, sensitivity, and remote effects rather than network access alone.
- Routine incidental methods do not need exact authorization; a broad goal still does not authorize consequential scope expansion, and failure does not expand authority.
- The isolated reviewer loads no extensions, skills, templates, themes, context files, or tools.

### FR-4: automatic session naming

The title namer must have an independent configuration:

```json
{
  "sessionTitle": {
    "provider": "provider-id",
    "model": "luna-model-id",
    "effort": "minimal",
    "maxWords": 6,
    "fallback": "heuristic"
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

### FR-7: Pi-Tai Host

The Host must:

- run as a separately launchable Tauri tray application in the initial product;
- continue when Zed and Pi-Tai Desktop disconnect;
- own broker session identity, command ordering, event history, revisions, and client attachments;
- serialize each session through one actor;
- permit every authenticated client to observe and submit supported state-changing commands;
- immediately attribute active control to the client whose valid mutation is durably accepted, without a takeover confirmation policy;
- deduplicate commands by operation ID and reject stale revisions or already-resolved interaction IDs;
- supervise a bundled TypeScript helper that uses Pi's SDK in-process;
- persist enough history to reload or resume sessions after a Host restart;
- report interrupted in-flight turns honestly rather than claiming transparent crash survival;
- expose authenticated local IPC to the ACP shim and desktop manager.

### FR-8: first-party ACP adapter

The ACP adapter must:

- use an exact-pinned `@agentclientprotocol/sdk/experimental/v2` and matched ACP v2 schema alpha for protocol transport and wire types;
- require explicit draft enablement in addition to negotiating protocol version 2;
- remain a thin, disposable shim over Host IPC;
- never own durable session state or terminate a session merely because Zed disconnects;
- negotiate capabilities instead of assuming a specific client and advertise `capabilities.session` only with the complete baseline method set;
- expose Host-backed new, list, resume with optional replay, close, prompt, cancellation, and update behavior; never implement v1 `session/load` in the initial shim;
- acknowledge accepted prompts immediately and represent foreground work through `running`, `requires_action`, and `idle` state updates;
- continue emitting semantically rich updates while idle rather than flattening events to request-scoped chat text;
- preserve Host-authored stable message, tool-call, terminal, plan, interaction, and foreground-operation IDs across live delivery and replay;
- explicitly convert omitted, `null`, replacement, and append patch semantics at the wire boundary without persisting generated ACP structs;
- validate item-plan, upserted-tool, structured-diff, and Agent-owned-terminal behavior against public ACP v2 fixtures and negotiated capabilities;
- omit ACP v1 fallback, Pi tree navigation, audio prompting, and Client filesystem/terminal execution surfaces;
- rely on Zed's existing thread completion and attention notifications.

### FR-9: desktop and mobile applications

- Pi-Tai Desktop uses Tauri with React and Vite.
- Its first release is limited to configuration, readiness, diagnostics, Host startup, and session status.
- Pi-Tai Mobile uses Tauri Mobile with React and Vite rather than React Native.
- Desktop and mobile share API types, state logic, design tokens, and appropriate responsive components.
- Mobile uses a versioned product API rather than raw ACP.
- Remote access is Tailscale-only initially and still requires product-level device authentication.
- Interactive desktop/mobile controls remain deferred until immediate control-transfer, revision-conflict, and idempotency behavior exists.

Detailed architecture and ACP scope are maintained in [HOST_ARCHITECTURE.md](HOST_ARCHITECTURE.md) and [ACP_SCOPE.md](ACP_SCOPE.md).

## Configuration principles

- Pi-Tai reads `~/.pi/agent/pi-tai.json` and trusted project `.pi/pi-tai.json` files because Pi's extension API does not expose arbitrary namespaced settings as a stable typed API.
- Project values override global values through an explicit schema-aware merge.
- Guardian has no separate configuration or persistent approval state.
- Model references use separate `provider` and `model` fields.
- No feature silently falls back to the expensive active work model.
- Invalid optional configuration warns and degrades safely.
- Security configuration fails closed where Guardian requires it.
- Project-local configuration is honored only for trusted projects.

## Licensing requirements

- Pi-Tai's original code remains MIT-licensed.
- Keep implementation and design artifacts product-owned and original.
- Honor dependency licenses through their normal package distributions when dependencies are added.

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

### Gate B: Host and Zed continuity acceptance

- Pi-Tai Host runs as a tray application and owns the Pi runtime independently of Zed.
- Pi-Tai ACP connects Zed to the running Host.
- new and existing broker sessions work.
- closing Zed does not intentionally stop a healthy active turn.
- reconnect and history replay are ordered and duplicate-free.
- model and effort selectors work.
- plans render through Zed's native plan support.
- titles update live.
- tool calls, diffs, locations, and terminal output are readable.
- Guardian decisions remain safe and understandable.

### Gate C: companion observer acceptance

- Pi-Tai Desktop can configure and report the status of the Host.
- a paired Tauri mobile client can list sessions and observe a live timeline through Tailscale.
- routine disconnection and reconnection lose no durable events.
- the mobile observer cannot mutate sessions before the remote-control command surface and Host arbitration are implemented.

## Open decisions

- Exact public name of the planning tool: `update_plan` is the current preference.
- Exact Luna provider/model IDs for the user's configuration.
- Whether priorities should be required by the planning tool or default to `medium`.
- Whether Guardian accepts an upstream context-provider contribution.
- Whether the Host and Desktop ship as two visible application bundles or one signed bundle containing the Host helper application.
- Exact model-visible steering semantics for an externally replaced plan during an active turn.
- Whether the ACP executable is installed globally from Git or through a future ACP Registry entry.
