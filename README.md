# pi-tai

`pi-tai` is a Git-installable [Pi](https://pi.dev) distribution with background subagents, managed JJ workspaces, a Design–Plan–Implement–Closure workflow, independent session naming, Approval Guardian, native notifications, and terminal-aware ANSI themes.

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

### Design–Plan–Implement–Closure

`/dpic [work description]` starts or continues Design–Plan–Implement–Closure for large or consequential work, following the packaged `dpic` skill. Design and planning stay in the main conversation, on the model you chose, so you can argue with them; implementation is delegated to subagents working in their own checkouts. Closure covers documentation and status updates, independent review, conflict reconciliation on merge, verification, and cleanup. The skill scales the ceremony to the work, and says so explicitly for changes small enough to make directly.

### Jujutsu version-control guidance

The packaged `jj-guidelines` skill keeps Jujutsu inspection, checkpoints, mutable-stack cleanup, workspace management, and Conventional Commit descriptions safe and reviewable. It prefers JJ in JJ repositories, remains read-only without mutation authority, and leaves completed checkpoints on a fresh empty change.

### Invariant-driven modeling

The packaged `invariants` skill guides domain models, APIs, state machines, wire contracts, and persistence schemas toward representations where invalid states are difficult or impossible to express. It emphasizes authoritative facts, discriminated states, validated boundaries, and explicit transitions.

### Checkpoint prompt

`/checkpoint [additional instructions]` organizes all current work into coherent semantic changes. Optional instructions can refine grouping, descriptions, or validation while retaining the prompt's safety requirements.

### Contextual external editor

In the interactive TUI, Ctrl-G opens the external editor with a non-submitted preview of the last assistant message followed by an empty `<response>` block. Only text inside that block returns to Pi; if the closing tag is removed, the response continues to end-of-file. If no opening response tag is detected, the entire edited document returns to Pi as the response. Existing editor text is placed inside the response block, while sessions without an assistant message retain Pi's normal plain-document behavior.

When the effective editor command launches NeoVim (`nvim`, an executable path, or an `env`-wrapped command), Pi-Tai adds a startup command that places the cursor on the response line. Other editors receive no extra arguments.

### Independent session naming

After the first meaningful request settles, Pi-Tai names an unnamed session with an independently configured provider/model. The naming request uses no tools and a small output budget. It never silently falls back to the active work model; missing or failed title-model configuration uses a deterministic local title instead.

### Hosted web research and safe page fetches

Pi-Tai registers `web_search` and `web_fetch` as normal standalone tools, available to the main session and to subagents alike. `web_search` uses `openai-codex/gpt-5.6-terra`, Pi's existing Codex OAuth, and OpenAI's hosted live search; optional `allowedDomains` restricts discovery to public DNS hostnames. The isolated nested request receives only the research query, exposes no local tools, and returns a concise linked answer with nested usage accounting.

`web_fetch` performs an anonymous GET for one known public HTTP(S) URL, converts HTML to readable linked text, and supports an `offset` for bounded continuation. Guardian reviews every fetch before network access. Deterministic checks still reject credentials in URLs, private or intranet names and addresses, mixed public/private DNS answers, metadata endpoints, non-routable targets, unsafe redirects, oversized responses, and unsupported binary media. For documentation discovery, agents may explicitly fetch a site-root `/llms.txt`; Pi-Tai never assumes or automatically fetches `llms-full.txt`.

### Subagents and managed workspaces

A subagent is a background agent with its own context window, given one self-contained objective and a working directory. `subagent_spawn` starts one and returns immediately; its result is delivered into the conversation when the parent next goes idle, so the parent keeps working instead of polling. `subagent_wait` blocks only when an answer is genuinely needed, returning on the first requested completion and supporting repeated collection of the remaining agents; foreground user input releases the wait without cancelling or steering pending children. `subagent_check`, `subagent_send`, `subagent_cancel`, and `subagent_list` cover inspection, correction, and stopping. Subagents are one level deep: a subagent does not spawn its own.

`isolation` says where a subagent works, not what it may do. With `isolation: "workspace"` it gets its own Jujutsu checkout, branched from the same parents as your working copy `@`, so it sees everything you have landed without seeing your in-flight change; its work stays there until `workspace_merge` folds it in or `workspace_discard` throws it away. With `isolation: "shared"` it works directly in your working copy alongside you. `workspace_status` lists managed workspaces, including any a crashed session left behind. Merging keeps history linear when that applies cleanly and otherwise merges the subagent's work in under your working commit, where any conflict surfaces as an ordinary conflict you resolve by editing. Nothing lands in your working copy on its own.

Three harnesses can run a subagent: `pi` (an in-process Pi SDK session), `claude` (the Claude Agent SDK), and `codex` (`codex app-server`). All are offered, and one whose SDK or binary is missing reports itself unavailable with a reason. Model aliases come from a validated packaged JSON catalog and carry a provider/model, reasoning effort, and compatible harnesses: `sol` is the implementation default; `terra` and `luna` provide the other GPT-5.6 choices; `glm` and `kimi` select GLM 5.2 and Kimi K3 through OpenCode Go on Pi; and `opus`, `sonnet`, and user-requested `fable` run only through Claude Code. Incompatible model/backend pairs are rejected rather than silently rerouted. A subagent that has settled on `claude` or `codex` can be continued with `subagent_send`, which resumes its session; `subagent_spawn` with `continue` instead starts a fresh subagent in an existing workspace, which is how a failed or cancelled run is picked up on a different harness or a stronger model.

At most four subagents run at once. Parents can continue independent work while children run, but remain responsible for avoiding duplicate assignments and conflicting edits, and for reviewing a subagent's changes before merging them. See [Subagents and workspaces](docs/concurrency/README.md) for the workspace lifecycle, the harness layer, model resolution, and why the design is shaped this way.

### Model profiles and effort

Independent model profiles now live in `pi-tai.json`. Shift+Tab cycles profiles in configured order, while Ctrl+Alt+T retains Pi's native thinking-level cycle. Pi-Tai provisions these as first-party bindings in `~/.pi/agent/keybindings.json`, preserving unrelated bindings and any additional keys assigned to thinking-level cycling. `/profile` selects a profile directly, `/effort` changes reasoning effort independently, and Pi's `/model` remains available for unrestricted model selection.

### Approval Guardian

Pi-Tai includes a standalone autonomy-first action guardian. Every agent-generated `bash` and `web_fetch` call is reviewed by `openai-codex/codex-auto-review` using Pi's Codex OAuth provider. The reviewer independently classifies risk, task relationship (`explicit`, `direct`, `supporting`, `unrelated`, or `unclear`), impact scope, and harm kinds. Low/medium-risk work proceeds without method-level permission, including repository understanding, diagnostics, linting, tests, builds, dependency work, configured CI uploads, and communication with development SaaS backends. High/critical actions never execute through an agent: related actions are blocked and surfaced to the human with the exact proposed action for direct execution, while unrelated or unclear actions are denied without a runnable command. Destructive candidates also stop safely when review is unavailable; ordinary actions proceed. Child Guardians route human-execution requirements directly to the root session so intermediate agents cannot authorize or perform them. Review failures and denials are retained locally under `~/.pi/agent/pi-tai/guardian-reviews/` for evaluation.

Built-in file tools use deterministic canonical boundaries. Unignored repository files remain frictionless; direct targets ignored by Git, likely credential paths, VCS metadata, Pi `auth.json`, Pi `models.json`, and Pi `sessions/**` receive Guardian review. Repository-wide `grep` and `find` retain their native Git-ignore behavior. Read-only tools may additionally inspect safe Pi state/resources and global `.agents/skills`; Pi-state writes and outside-boundary file operations remain blocked, with reviewed `bash` as the escalation path. Traversal and symlink escapes are always blocked.

Pi-Tai does not provide legacy permission modes. `/mode` and `/review-mode` are intentionally absent. `/dpic` starts a workflow, not a permission or tool-access mode.

### Percentage-based automatic compaction

Pi already provides reserve-token-based automatic compaction. Pi-Tai adds a model-independent percentage threshold: after an agent run fully settles, known context usage at or above 90% is compacted before later settled handlers run. If Pi's native policy already compacted the session, post-compaction usage is unknown and Pi-Tai does not compact again. Configure or disable this policy with `compaction` in `pi-tai.json`.

### Native notifications and cmux presence

In interactive terminal sessions, Pi-Tai uses Kitty OSC 99 or OSC 777 notifications plus an audible terminal bell. Notifications identify the session; completion notifications summarize the assistant's response, and Guardian failures name the affected tool and reason.

Inside cmux, Pi-Tai composes only `pi-cmux`'s notification and sidebar modules to show live status, progress, token totals, logs, and completion alerts. Activation requires `CMUX_WORKSPACE_ID`, a `cmux` executable on `PATH`, and the default-enabled `cmux.enabled` preference. Native completion notifications then stand down to prevent duplicates. When any requirement is absent, Pi-Tai does not initialize the cmux modules and preserves native notifications.

Pi-Tai passes upstream `PI_CMUX_*` environment controls through unchanged but does not install `pi-cmux`'s pane, continuation, review, directory-jump, or command-running features. See [Pi-Tai settings](SETTINGS.md) for configuration, environment controls, and troubleshooting.

### ANSI theme synchronization

In interactive TUI sessions only, Pi-Tai queries the terminal background with OSC 11 and selects `ansi-dark` or `ansi-light`. Polling starts on session startup and is cancelled on shutdown or reload. Print, JSON, and RPC modes never access `/dev/tty`.

## Configuration

The direct Pi extension reads these files at session start:

```text
~/.pi/agent/pi-tai.json
<project>/.pi/pi-tai.json
```

Project configuration is loaded only for a trusted project. It may override unprivileged compaction and client-preference fields, but model-selecting `sessionTitle` and `modelProfiles` values are ignored with a warning. Host-managed sessions instead have the Host resolve and pin session policy at creation; their runtime worker does not reread these files. See [Pi-Tai settings](SETTINGS.md) for ownership, precedence, field constraints, and defaults.

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
  "cmux": {
    "enabled": true
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
packages/pi-tai/src/concurrency/    Host-backed task, event, projection, usage, and migration state
packages/pi-tai/src/subagents/      packaged instructions composed into a session's system prompt
packages/pi-tai/src/agents/         subagent tools, harnesses, model aliases, and result delivery
packages/pi-tai/src/isolation/      managed JJ workspace allocation, merge, and reclamation
packages/pi-tai/src/jj/             enrolled repository and managed JJ workspace operations
packages/pi-tai/skills/             specialized version-control, invariant, DPIC, and documentation guidance
packages/pi-tai/prompts/            checkpoint and DPIC prompt commands
packages/pi-tai/src/session-title/  independent title generation
packages/pi-tai/src/guardian/       standalone action review and path boundaries
packages/pi-tai/src/web/            hosted web search and public-only page fetching
packages/pi-tai/src/notifications/  native review/completion notifications
packages/pi-tai/src/ansi-theme/     TUI-only terminal theme lifecycle
packages/pi-tai/themes/             packaged dark and light themes
apps/host/                            macOS-first Tauri Host Agent proof
packages/host-protocol/              TypeScript Host protocol contract
crates/host-lifecycle/               portable Host lifecycle policy
crates/host-platform/                OS readiness adapter contracts
crates/host-protocol/                portable Rust Host protocol contract
fixtures/host-protocol/              shared cross-language protocol fixtures
docs/architecture/                   end-state product and system architecture
docs/concurrency/                    subagent and JJ workspace design
docs/roadmap/                        migration initiatives and sequencing
tests/                               unit, integration, repository, and smoke tests
```

Start with the [documentation index](docs/README.md), then follow the [product](docs/PRODUCT.md), [system architecture](docs/architecture/README.md), [subagents and workspaces](docs/concurrency/README.md), or [roadmap](docs/roadmap/README.md) reading path.

## License

Pi-Tai is MIT licensed.
