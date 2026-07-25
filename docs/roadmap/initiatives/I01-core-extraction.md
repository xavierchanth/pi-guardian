# I01 — Extract the shared core

**Status:** Planned  
**Depends on:** I00

## Outcome

Reusable Pi-Tai behavior lives behind a shared `@pi-tai/core` boundary. The existing direct Pi distribution remains a legacy harness during migration; the separate `pi-tai-client` reuses terminal presentation without owning agent behavior.

## Scope

- Define core ports for sessions/events, artifacts, Pi SDK contexts, models, machine capabilities, JJ, clock, and IDs.
- Move pure domains and application services for work context, agents/concurrency, Guardian, web policy, JJ/workspaces, usage, model/compaction/title policy.
- Keep terminal footer, ANSI theme, keybindings, response editor, terminal notifications, and Pi TUI command rendering in the CLI package.
- Split feature policy and tool declarations from Pi registration hooks.
- Break `concurrency → subagents store/task` legacy coupling by moving durable concepts to core domains.
- Keep the root Git-installable Pi distribution usable during extraction, without treating that temporary packaging contract as permanent authority.

## Migration constraints

- Move one behavior boundary at a time behind compatibility facades.
- No terminal or TUI import may enter core.
- Do not create one npm package per subsystem.
- Preserve test injection seams and isolated-load behavior.

## Exit criteria

- Core can be instantiated headlessly with fake ports.
- `pi-tai-client` composes ACP projection plus terminal adapters and no agent harness authority.
- Runtime worker can depend on core without importing CLI presentation.
- Core state machines reject invalid migration DTO combinations.
- No duplicate implementation of work context, Guardian, session policy, or concurrency behavior remains.
