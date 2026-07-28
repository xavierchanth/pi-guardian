# pi-tai

`pi-tai` is a Git-installable [Pi](https://pi.dev) distribution with durable task context, managed isolated workspaces and declarative subagents, a Design–Plan–Implement–Confirm workflow, independent session naming, Approval Guardian, native notifications, and terminal-aware ANSI themes.

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

### Design–Plan–Implement–Confirm

`/dpic [work description]` enables subagents and starts or continues a complete Design–Plan–Implement–Confirm workflow. Without a description, the Orchestrator first asks what to work on. It grounds Design in the repository and asks the user only for consequential unresolved decisions. It moves to Plan when the intended outcome, boundaries, constraints, key decisions, and acceptance criteria are clear enough that implementation will not invent product or architecture intent. It then queues plan-bound workspace work without a plan-approval ceremony, sends every nonempty result through independent review, returns blocking findings to implementation, and integrates only a clean reviewed range.

### Jujutsu version-control guidance

The packaged `jj-guidelines` skill keeps Jujutsu inspection, checkpoints, mutable-stack cleanup, workspace management, and Conventional Commit descriptions safe and reviewable. It prefers JJ in JJ repositories, remains read-only without mutation authority, and leaves completed checkpoints on a fresh empty change.

### Invariant-driven modeling

The packaged `invariants` skill guides domain models, APIs, state machines, wire contracts, and persistence schemas toward representations where invalid states are difficult or impossible to express. It emphasizes authoritative facts, discriminated states, validated boundaries, and explicit transitions.

### Checkpoint prompt

`/checkpoint [additional instructions]` organizes all current work into coherent semantic changes. Optional instructions can refine grouping, descriptions, or validation while retaining the prompt's safety requirements.

### Durable task trees

Packaged concurrency roles use Host-persisted task trees with immutable Orchestrator goals, sourced user directions, plan-bound child assignments, effective plans backed by append-only revision history, and immutable full-history review snapshots. Scoped `task_*` tools are authoritative. The legacy `update_plan` tool and `/plan-status` command are not exposed by the production package.

### Contextual external editor

In the interactive TUI, Ctrl-G opens the external editor with a non-submitted preview of the last assistant message followed by an empty `<response>` block. Only text inside that block returns to Pi; if the closing tag is removed, the response continues to end-of-file. If no opening response tag is detected, the entire edited document returns to Pi as the response. Existing editor text is placed inside the response block, while sessions without an assistant message retain Pi's normal plain-document behavior.

When the effective editor command launches NeoVim (`nvim`, an executable path, or an `env`-wrapped command), Pi-Tai adds a startup command that places the cursor on the response line. Other editors receive no extra arguments.

### Independent session naming

After the first meaningful request settles, Pi-Tai names an unnamed session with an independently configured provider/model. The naming request uses no tools and a small output budget. It never silently falls back to the active work model; missing or failed title-model configuration uses a deterministic local title instead.

### Hosted web research and safe page fetches

Pi-Tai registers `web_search` and `web_fetch` as normal standalone tools and grants both explicitly to the packaged orchestrator, implementation-lead, and researcher roles. `web_search` uses `openai-codex/gpt-5.6-terra`, Pi's existing Codex OAuth, and OpenAI's hosted live search; optional `allowedDomains` restricts discovery to public DNS hostnames. The isolated nested request receives only the research query, exposes no local tools, and returns a concise linked answer with nested usage accounting.

`web_fetch` performs an anonymous GET for one known public HTTP(S) URL, converts HTML to readable linked text, and supports an `offset` for bounded continuation. Guardian reviews every fetch before network access. Deterministic checks still reject credentials in URLs, private or intranet names and addresses, mixed public/private DNS answers, metadata endpoints, non-routable targets, unsafe redirects, oversized responses, and unsupported binary media. For documentation discovery, agents may explicitly fetch a site-root `/llms.txt`; Pi-Tai never assumes or automatically fetches `llms-full.txt`.

### Managed workspaces and declarative subagents

Pi-Tai supports Jujutsu workspaces only. Host sessions and isolated implementation children use deterministic, custodied workspace operations rather than a model-directed workspace skill. Child workspace creation branches from recorded source `@-`, so source `@` may contain ongoing work. Integration preserves source work and is gated by exact identity, review, receipt, verification, and closure checks.

Subagents are disabled by default. Bare `/subagents` toggles them. `/subagents on` applies the scoped root agent definition (packaged as `orchestrator`), including its model, effort, exact tools, prompt, and allowed children. `/subagents off` restores the previous main-session model, effort, and tools after direct children resolve; `/subagents force-off` recursively terminates unresolved descendants first. `/subagents list` opens the active/inactive tree and `/subagents inspect [delegation-id]` opens detail. `/capabilities` now reports subagents rather than workspace backends.

Agent definitions are Markdown files with YAML front matter. Packaged defaults live in `packages/pi-tai/agents`; user definitions in `~/.pi/agent/agents` override them, and trusted nearest-project `.pi/agents` definitions have highest precedence. The Orchestrator collaborates with the user during Design, persists the Plan, then may spawn an Implementation Lead, Documenter, Reviewer, Scout, or Researcher. Implementation Leads may spawn Workers, Scouts, or Researchers; Workers may spawn Scouts or Researchers. Documenters cannot delegate. There is exactly one Orchestrator, and only it owns workspace lifecycle and integration tools. Graph validation rejects missing children, root delegation, and cycles.

The normal `subagent` tool launches a private in-process Pi SDK context for read-only evidence or an allowed same-workspace child. `workspace_subagent` is Orchestrator-only, requires a durable assignment bound to a persisted Orchestrator plan, and launches either an Implementation Lead for product work or a Documenter for standalone architecture, roadmap, and documentation updates. The Orchestrator has no file-editing authority and cannot launch generic Workers directly. `integrate_workspace` updates stale, validates the full ancestry, forgets and removes the workspace, strips every empty delegated revision, and inserts retained changes before source `@` even when source work is active. It reports undescribed Change IDs for orchestrator inspection and `describe_integrated_changes`. Any graph mismatch, recovery history, conflict, or partial operation enters a non-retryable user-attention state.

Parents can continue independent work while children run, but remain responsible for avoiding duplicate assignments and conflicting edits. Child questions, status, terminal results, and incidents are pushed as bounded semantic events; parents wait with `await_child_event`, request focused status explicitly, and acknowledge terminal events with `ack_child_event`. No production tool polls child files or reads private child history. Every nonempty delegated workspace is independently reviewed in that same workspace before integration. The footer shows `orchestrator` beside the directory while subagents are enabled; workspace backends do not appear as capabilities.

Independent model profiles now live in `pi-tai.json`. Shift+Tab cycles profiles in configured order, while Ctrl+Alt+T retains Pi's native thinking-level cycle. Pi-Tai provisions these as first-party bindings in `~/.pi/agent/keybindings.json`, preserving unrelated bindings and any additional keys assigned to thinking-level cycling. `/profile` selects a profile directly, `/effort` changes reasoning effort independently, and Pi's `/model` remains available for unrestricted model selection. See the [`agent concurrency design`](docs/concurrency/README.md) for routing, roles, ownership, child runtime, JJ coordination, review, integration, and recovery.

### Approval Guardian

Pi-Tai includes a standalone autonomy-first action guardian. Every agent-generated `bash` and `web_fetch` call is reviewed by `openai-codex/codex-auto-review` using Pi's Codex OAuth provider. The reviewer independently classifies risk, task relationship (`explicit`, `direct`, `supporting`, `unrelated`, or `unclear`), impact scope, and harm kinds. Low/medium-risk work proceeds without method-level permission, including repository understanding, diagnostics, linting, tests, builds, dependency work, configured CI uploads, and communication with development SaaS backends. High/critical actions never execute through an agent: related actions are blocked and surfaced to the human with the exact proposed action for direct execution, while unrelated or unclear actions are denied without a runnable command. Destructive candidates also stop safely when review is unavailable; ordinary actions proceed. Child Guardians route human-execution requirements directly to the root session so intermediate agents cannot authorize or perform them. Review failures and denials are retained locally under `~/.pi/agent/pi-tai/guardian-reviews/` for evaluation.

Built-in file tools use deterministic canonical boundaries. Unignored repository files remain frictionless; direct targets ignored by Git, likely credential paths, VCS metadata, Pi `auth.json`, Pi `models.json`, and Pi `sessions/**` receive Guardian review. Repository-wide `grep` and `find` retain their native Git-ignore behavior. Read-only tools may additionally inspect safe Pi state/resources and global `.agents/skills`; Pi-state writes and outside-boundary file operations remain blocked, with reviewed `bash` as the escalation path. Traversal and symlink escapes are always blocked.

Pi-Tai does not provide legacy permission modes. `/mode` and `/review-mode` are intentionally absent. `/dpic` activates the Orchestrator workflow; it is not a permission or tool-access mode.

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
packages/pi-tai/src/subagents/      private SDK delegation and orchestration lifecycle
packages/pi-tai/src/jj/             enrolled repository and managed JJ workspace operations
packages/pi-tai/agents/             orchestrator, implementation-lead, documenter, worker, reviewer, scout, researcher
packages/pi-tai/skills/             specialized version-control, invariant, and documentation guidance
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
docs/concurrency/                    agent concurrency and JJ design
docs/roadmap/                        migration initiatives and sequencing
tests/                               unit, integration, repository, and smoke tests
```

Start with the [documentation index](docs/README.md), then follow the [product](docs/PRODUCT.md), [system architecture](docs/architecture/README.md), [concurrency specification](docs/concurrency/README.md), or [roadmap](docs/roadmap/README.md) reading path.

## License

Pi-Tai is MIT licensed.
