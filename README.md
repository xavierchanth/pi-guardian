# pi-tai

`pi-tai` is a Git-installable [Pi](https://pi.dev) distribution with structured work context, capability-gated isolated workspaces and subagents, prompt-based work continuation, independent session naming, Approval Guardian, native notifications, and terminal-aware ANSI themes.

## Install

Install a reviewed tag rather than a moving branch:

```sh
pi install git:github.com/xavierchanth/pi-tai@v0.1.0
```

For local development or one-off testing:

```sh
pi -ne -e . "<your-prompt>"
```

## Run Pi-Tai from this checkout

The repository includes a `justfile` that starts an isolated Pi process with this package as its only extension distribution:

```sh
# Open the interactive Pi TUI
just pitai

# Run one prompt non-interactively
just pitai "Explain the current project"
```

`just pi` and `just pi-tai` are aliases for the same recipe. Run `just` to list development commands such as `check`, `smoke`, and `package-check`.

The recipe executes `pi -ne -e <repository-root>`, so unrelated globally installed extensions are disabled while Pi-Tai is loaded from the current checkout.

Upgrade by selecting a new explicit tag:

```sh
pi install git:github.com/xavierchanth/pi-tai@v0.1.1
```

## Included plugins

### Open-ended design prompt

Use `/design [focus]` to start an investigative design phase before implementation. The agent consults you where key decisions or clarification need your input, then produces an implementation plan once the design is sufficiently resolved.

### Structured work context

The `update_plan` tool stores a complete goal and replacement plan in Pi tool-result details. State follows Pi's active session branch and survives resume, tree navigation, and compaction.

- Plans are optional for simple work.
- At most one item may be `in_progress`.
- An item must be accepted as `in_progress` before it becomes `completed`.
- Every update contains the complete replacement plan.

In interactive TUI sessions, active work context appears below the editor as a responsive two-line widget:

```text
Goal: Ship terminal refresh
Plan: 2/5 | Now: Integrate Guardian
```

Long goal and active-step text is truncated to the available terminal width. Run `/plan-status` for a read-only full-plan view. `update_plan` results show a compact progress summary by default and the full checklist when tool output is expanded.

### Work continuation prompt

Use `/continue` after interrupting the agent. It expands to the visible prompt `Continue what you were doing.` and starts a normal turn.

### Contextual external editor

In the interactive TUI, Ctrl-G opens the external editor with a non-submitted preview of the last assistant message followed by an empty `<response>` block. Only text inside that block returns to Pi; if the closing tag is removed, the response continues to end-of-file. Removing the opening tag safely leaves the original draft unchanged. Existing editor text is placed inside the response block, while sessions without an assistant message retain Pi's normal plain-document behavior.

When the effective editor command launches NeoVim (`nvim`, an executable path, or an `env`-wrapped command), Pi-Tai adds a startup command that places the cursor on the response line. Other editors receive no extra arguments.

### Independent session naming

After the first meaningful request settles, Pi-Tai names an unnamed session with an independently configured provider/model. The naming request uses no tools and a small output budget. It never silently falls back to the active work model; missing or failed title-model configuration uses a deterministic local title instead.

### Isolated workspaces and persistent subagents

Workspace capabilities are disabled by default. In a standalone session, `/cap:jj-workspaces new <name>` or `/cap:git-worktrees new <name>` creates an isolated checkout, forks the complete Pi session, and continues the same logical agent there as a standalone successor session. `on`, `off`, `status`, and `create-only` are also available under each namespace.

The shared model profiles are always available, including when subagents are disabled. Use `/model:thinker`, `/model:worker`, or `/model:mechanical` to switch the current session directly to that profile's model and thinking effort.

Subagents are disabled by default. Run `/cap:subagents on` to make the current session a parent, `/cap:subagents status` to inspect it, or `/cap:subagents off` after every child is resolved. New and ordinary forked sessions start standalone.

A parent delegates workspace work with `spawn_child`; direct `jj workspace add`, `git worktree add`, and relocation tools are blocked in parent mode. Every direct child receives:

- an independent persistent Pi session and detached process;
- a dedicated JJ workspace always rooted at the parent's `@-` change—without requiring or modifying parent `@`—when JJ is available, otherwise a dedicated Git branch/worktree;
- one shared model profile (`thinker`, `worker`, or `mechanical`);
- only `report_to_parent`, with no ability to delegate further.

Parents receive `spawn_child`, `message_child`, `wait_for_children`, `child_status`, `integrate_child`, and `abandon_child`. The child exclusively owns its delegated workspace and performs all repository reading, editing, testing, and VCS work there. While a child is active, parent work tools are blocked: the parent can message, inspect status through child controls, wait for, or abandon the child, but it cannot touch or duplicate the child's work in the main thread. Persistent RPC children receive steering or follow-up instructions through private FIFOs, and `wait_for_children` waits without parent model calls until its snapshot reports. JJ child stacks preserve all descendants through subtree rebase; Git children report a clean committed branch and preserve commits through reviewed non-squash integration. Dirty Git worktrees are retained for recovery rather than force-removed.

Pi-Tai composes normal Pi context with three intentionally empty, user-authored files: `packages/pi-tai/instructions/system.md`, `parent.md`, and `child.md`. It also adds generated factual role/delegation metadata. See [`docs/SUBAGENTS.md`](docs/SUBAGENTS.md) for lifecycle and recovery details.

### Approval Guardian

Pi-Tai includes a standalone autonomy-first action guardian. Every agent-generated `bash` call is reviewed by `openai-codex/codex-auto-review` using Pi's Codex OAuth provider. The reviewer independently scores risk and user authorization: routine low/medium-risk task work proceeds without method-level permission, high-risk work requires meaningful authorization and narrow scope, and critical work never executes automatically. Guardian never asks for approval: every non-allow result becomes a failed tool result and the agent continues with other authorized work. Invalid, timed-out, cancelled, and failed reviews fail closed. Non-allow review records are retained locally under `~/.pi/agent/pi-tai/guardian-reviews/` for evaluation.

Built-in file tools use deterministic canonical boundaries. Unignored repository files remain frictionless; direct targets ignored by Git, likely credential paths, VCS metadata, Pi `auth.json`, Pi `models.json`, and Pi `sessions/**` receive Guardian review. Repository-wide `grep` and `find` retain their native Git-ignore behavior. Read-only tools may additionally inspect safe Pi state/resources and global `.agents/skills`; Pi-state writes and outside-boundary file operations remain blocked, with reviewed `bash` as the escalation path. Traversal and symlink escapes are always blocked.

Pi-Tai does not provide legacy permission modes. `/mode`, `/review-mode`, and `/implement` are intentionally absent.

### Native notifications

In interactive terminal sessions, Pi-Tai uses Kitty OSC 99 or OSC 777 notifications plus an audible terminal bell. Notifications fire when automatic review fails or times out and when the agent settles ready for input. Failure and completion notifications can be disabled in configuration.

### ANSI theme synchronization

In interactive TUI sessions only, Pi-Tai queries the terminal background with OSC 11 and selects `ansi-dark` or `ansi-light`. Polling starts on session startup and is cancelled on shutdown or reload. Print, JSON, and RPC modes never access `/dev/tty`.

## Configuration

Pi-Tai reads these files:

```text
~/.pi/agent/pi-tai.json
<project>/.pi/pi-tai.json
```

Project configuration is loaded only for a trusted project and overrides global values.

```json
{
  "sessionTitle": {
    "provider": "provider-id",
    "model": "luna-model-id",
    "effort": "minimal",
    "maxWords": 6,
    "fallback": "heuristic"
  },
  "ansiTheme": {
    "darkTheme": "ansi-dark",
    "lightTheme": "ansi-light",
    "pollIntervalMs": 2000
  },
  "notifications": {
    "reviewFailure": true,
    "agentCompletion": true
  }
}
```

Guardian has no permission modes, command allowlists, persistent bypasses, or separate configuration surface.

## Development

Requirements: Node 22.19 or newer and npm.

```sh
npm ci
npm run check
npm run package:check
npm run smoke:isolated
```

`smoke:isolated` starts Pi in offline RPC mode with only this distribution loaded. The real-agent acceptance command remains:

```sh
pi -ne -e . "Reply with exactly: pi-tai-loaded"
```

## Repository layout

```text
justfile                            local Pi-Tai terminal launcher
packages/pi-tai/pi-tai.ts           Pi extension composition root
packages/pi-tai/src/config/         trusted Pi-Tai configuration
packages/pi-tai/src/work-context/   update_plan domain and persistence
packages/pi-tai/src/session-title/  independent title generation
packages/pi-tai/src/guardian/       standalone action review and path boundaries
packages/pi-tai/src/notifications/  native review/completion notifications
packages/pi-tai/src/ansi-theme/     TUI-only terminal theme lifecycle
packages/pi-tai/themes/             packaged dark and light themes
packages/pi-tai/prompts/            /design and /continue prompt templates
apps/host/                            macOS-first Tauri Host Agent proof
packages/host-protocol/              TypeScript Host protocol contract
crates/host-lifecycle/               portable Host lifecycle policy
crates/host-platform/                OS readiness adapter contracts
crates/host-protocol/                portable Rust Host protocol contract
fixtures/host-protocol/              shared cross-language protocol fixtures
docs/adr/                            accepted architecture decisions
tests/                               unit, integration, repository, and smoke tests
```

Architecture and future Host work are documented under [`docs/`](docs/PRD.md).

## License

Pi-Tai is MIT licensed.
