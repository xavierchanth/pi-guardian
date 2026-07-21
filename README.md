# pi-tai

`pi-tai` is a Git-installable [Pi](https://pi.dev) distribution with structured work context, hidden work continuation, independent session naming, Approval Guardian, and terminal-aware ANSI themes.

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

### Hidden work continuation

Use `/continue` after interrupting the agent to send `Continue what you were doing.` and start another turn. The continuation is hidden from the chat transcript but persists as model context. The command refuses arguments, empty conversations, and invocations while the agent is still working.

### Independent session naming

After the first meaningful request settles, Pi-Tai names an unnamed session with an independently configured provider/model. The naming request uses no tools and a small output budget. It never silently falls back to the active work model; missing or failed title-model configuration uses a deterministic local title instead.

### Approval Guardian

Pi-Tai includes a small standalone action guardian. Every agent-generated `bash` call is reviewed by `openai-codex/codex-auto-review` using Pi's Codex OAuth provider. Each review includes the latest structured work context (goal, explanation, and complete plan) as explicit task evidence, separate from user authorization. Built-in file tools stay local to canonical workspace and OS temporary roots; traversal and symlink escapes are blocked. A denied or failed review may be approved only for that exact invocation in the interactive TUI.

Pi-Tai does not provide legacy permission modes. `/mode`, `/review-mode`, and `/implement` are intentionally absent.

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
packages/pi-tai/extension.ts        Pi extension composition root
packages/pi-tai/src/config/         trusted Pi-Tai configuration
packages/pi-tai/src/work-context/   update_plan domain and persistence
packages/pi-tai/src/session-title/  independent title generation
packages/pi-tai/src/guardian/       standalone action review and path boundaries
packages/pi-tai/src/ansi-theme/     TUI-only terminal theme lifecycle
packages/pi-tai/themes/             packaged dark and light themes
packages/pi-tai/prompts/design.md   /design prompt template
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
