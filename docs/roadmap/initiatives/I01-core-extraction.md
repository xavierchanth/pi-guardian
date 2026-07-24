# I01 — Extract the shared core

**Status:** Planned  
**Depends on:** I00

## Outcome

Reusable Pi-Tai behavior lives behind a shared `@pi-tai/core` boundary. The existing Pi distribution becomes a CLI/TUI adapter rather than the composition owner of all product behavior.

## Scope

- Define core ports for sessions/events, artifacts, Pi SDK contexts, models, machine capabilities, JJ, clock, and IDs.
- Move pure domains and application services for work context, agents/concurrency, Guardian, web policy, JJ/workspaces, usage, model/compaction/title policy.
- Keep terminal footer, ANSI theme, keybindings, response editor, terminal notifications, and Pi TUI command rendering in the CLI package.
- Split feature policy from Pi registration hooks.
- Break `concurrency → subagents store/task` legacy coupling by moving durable concepts to core domains.
- Keep the root Git-installable Pi distribution contract intact during extraction.

## Migration constraints

- Move one behavior boundary at a time behind compatibility facades.
- No terminal or TUI import may enter core.
- Do not create one npm package per subsystem.
- Preserve test injection seams and isolated-load behavior.

## Exit criteria

- Core can be instantiated headlessly with fake ports.
- Pi CLI composes core plus terminal adapters.
- Runtime worker can depend on core without importing CLI presentation.
- Core state machines reject invalid migration DTO combinations.
- No duplicate implementation of work context, Guardian, session policy, or concurrency behavior remains.
