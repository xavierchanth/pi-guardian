# pi-tai

`pi-tai` is a Git-installable [Pi](https://pi.dev) distribution with structured work context, request-triggered isolated workspaces and declarative subagents, prompt-based work continuation, independent session naming, Approval Guardian, native notifications, and terminal-aware ANSI themes.

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

In the interactive TUI, Ctrl-G opens the external editor with a non-submitted preview of the last assistant message followed by an empty `<response>` block. Only text inside that block returns to Pi; if the closing tag is removed, the response continues to end-of-file. If no opening response tag is detected, the entire edited document returns to Pi as the response. Existing editor text is placed inside the response block, while sessions without an assistant message retain Pi's normal plain-document behavior.

When the effective editor command launches NeoVim (`nvim`, an executable path, or an `env`-wrapped command), Pi-Tai adds a startup command that places the cursor on the response line. Other editors receive no extra arguments.

### Independent session naming

After the first meaningful request settles, Pi-Tai names an unnamed session with an independently configured provider/model. The naming request uses no tools and a small output budget. It never silently falls back to the active work model; missing or failed title-model configuration uses a deterministic local title instead.

### Hosted web research and safe page fetches

Pi-Tai registers `web_search` and `web_fetch` as normal standalone tools and grants both explicitly to the packaged thinker, planner, and researcher roles. `web_search` uses `openai-codex/gpt-5.6-terra`, Pi's existing Codex OAuth, and OpenAI's hosted live search; optional `allowedDomains` restricts discovery to public DNS hostnames. The isolated nested request receives only the research query, exposes no local tools, and returns a concise linked answer with nested usage accounting.

`web_fetch` performs an anonymous GET for one known public HTTP(S) URL, converts HTML to readable linked text, and supports an `offset` for bounded continuation. Guardian reviews every fetch before network access. Deterministic checks still reject credentials in URLs, private or intranet names and addresses, mixed public/private DNS answers, metadata endpoints, non-routable targets, unsafe redirects, oversized responses, and unsupported binary media. For documentation discovery, agents may explicitly fetch a site-root `/llms.txt`; Pi-Tai never assumes or automatically fetches `llms-full.txt`.

### Explicit workspaces and declarative subagents

Workspaces and worktrees are not session capabilities. The packaged `workspace` skill is advertised to the model and should load automatically when the user asks for a workspace, work tree, worktree, isolated checkout, or to avoid interfering with the main working directory; `/skill:workspace` remains available as a manual override. Its thin router probes JJ, loads the detailed JJ strategy when available, and loads the separate Git fallback only when JJ was unavailable before mutation. JJ creation branches from the recorded source `@-`, so source `@` may contain ongoing work and its files remain untouched. The current Pi session does not silently change cwd: work targets the new path explicitly, or the user can start `pi` from that path for a persistently relocated interactive session. Integration remains separate and requires an empty source working-copy revision before insertion.

Subagents are disabled by default. Bare `/subagents` toggles them. `/subagents on` applies the scoped root agent definition (packaged as `thinker`), including its model, effort, exact tools, prompt, and allowed children. `/subagents off` restores the previous main-session model, effort, and tools after direct children resolve; `/subagents force-off` recursively terminates unresolved descendants first. `/subagents list [delegation-id]` opens the child activity/detail view. `/capabilities` now reports subagents rather than workspace backends.

Agent definitions are Markdown files with YAML front matter. Packaged defaults live in `packages/pi-tai/agents`; user definitions in `~/.pi/agent/agents` override them, and trusted nearest-project `.pi/agents` definitions have highest precedence. Thinker may spawn planners, scouts, or researchers; planner may spawn workers, scouts, or researchers; worker may spawn scouts or researchers; specialists cannot delegate. Only thinker owns the planner-workspace tools, so a planner can never launch another planner or create another workspace. Graph validation rejects missing children, root delegation, and cycles.

The normal `subagent` tool launches a persistent isolated Pi process in the same cwd. For a substantial isolated subtask, thinker can use `planner_workspace` to create a JJ-preferred workspace and launch exactly one planner there. Creation may branch from source `@-` while source `@` contains ongoing work, without changing source files. Durable records retain the source workspace, base and root Change IDs, backend path, and integration phase. After source work has reached a fresh empty `@`, `integrate_planner_workspace` updates stale workspaces, validates the complete rooted subtree, and rebases it before that working-copy change without assuming a commit count. `cleanup_planner_workspace` remains a separate post-integration operation. Any graph mismatch, recovery history, conflict, partial integration, or cleanup error enters a non-retryable user-attention state and preserves the workspace.

Parents can continue independent work while children run, but remain responsible for avoiding duplicate assignments and conflicting edits. A below-editor widget shows each direct child's task, phase, and latest visible assistant line; `/subagents list` opens full details. Children must resolve their own descendants before reporting. The footer shows `thinker` beside the directory while subagents are enabled; workspace backends do not appear as capabilities.

Independent model profiles now live in `pi-tai.json`. Shift+Tab cycles profiles in configured order, while Ctrl+Alt+T retains Pi's native thinking-level cycle. Pi-Tai provisions these as first-party bindings in `~/.pi/agent/keybindings.json`, preserving unrelated bindings and any additional keys assigned to thinking-level cycling. `/profile` selects a profile directly, `/effort` changes reasoning effort independently, and Pi's `/model` remains available for unrestricted model selection. See [`docs/SUBAGENTS.md`](docs/SUBAGENTS.md) for the role schema and lifecycle.

### Approval Guardian

Pi-Tai includes a standalone autonomy-first action guardian. Every agent-generated `bash` and `web_fetch` call is reviewed by `openai-codex/codex-auto-review` using Pi's Codex OAuth provider. The reviewer independently scores risk and user authorization: routine low/medium-risk task work proceeds without method-level permission, high-risk work requires meaningful authorization and narrow scope, and critical work never executes automatically. Guardian never asks for approval: every non-allow result becomes a failed tool result and the agent continues with other authorized work. Invalid, timed-out, cancelled, and failed reviews fail closed. Non-allow review records are retained locally under `~/.pi/agent/pi-tai/guardian-reviews/` for evaluation.

Built-in file tools use deterministic canonical boundaries. Unignored repository files remain frictionless; direct targets ignored by Git, likely credential paths, VCS metadata, Pi `auth.json`, Pi `models.json`, and Pi `sessions/**` receive Guardian review. Repository-wide `grep` and `find` retain their native Git-ignore behavior. Read-only tools may additionally inspect safe Pi state/resources and global `.agents/skills`; Pi-state writes and outside-boundary file operations remain blocked, with reviewed `bash` as the escalation path. Traversal and symlink escapes are always blocked.

Pi-Tai does not provide legacy permission modes. `/mode`, `/review-mode`, and `/implement` are intentionally absent.

### Percentage-based automatic compaction

Pi already provides reserve-token-based automatic compaction. Pi-Tai adds a model-independent percentage threshold: after an agent run fully settles, known context usage at or above 90% is compacted before later settled handlers run. If Pi's native policy already compacted the session, post-compaction usage is unknown and Pi-Tai does not compact again. Configure or disable this policy with `compaction` in `pi-tai.json`.

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
  },
  "compaction": {
    "enabled": true,
    "thresholdPercent": 90
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
packages/pi-tai/src/compaction/     percentage-based automatic compaction
packages/pi-tai/src/keybindings/    first-party keyboard mappings
packages/pi-tai/src/work-context/   update_plan domain and persistence
packages/pi-tai/src/subagents/      delegation and planner-workspace lifecycle
packages/pi-tai/src/workspaces/     JJ-preferred workspace backend operations
packages/pi-tai/agents/             thinker, planner, worker, scout, researcher
packages/pi-tai/skills/             request-triggered workspace router and backend strategies
packages/pi-tai/src/session-title/  independent title generation
packages/pi-tai/src/guardian/       standalone action review and path boundaries
packages/pi-tai/src/web/            hosted web search and public-only page fetching
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
