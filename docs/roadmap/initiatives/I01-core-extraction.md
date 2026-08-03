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

## Module disposition

The cutover removes **Pi harness responsibilities**, not necessarily the Pi client. A feasibility spike must first prove Pi can operate as an ACP client with the Host as sole authority (I04).

| Module | Disposition |
|---|---|
| `response-editor/` | Reassess for the Pi client; delete if ACP/client editing makes it redundant |
| `footer/` | Retain only as Pi client chrome |
| `ansi-theme/` | Retain as Pi client-local preferences and presentation |
| `keybindings/` | Retain client-local bindings only; stop mutating Host or policy configuration |
| `notifications/` | Retain as a Pi client projection of ACP updates |
| `themes/` | Retain while the Pi ACP client is supported |

`concurrency`, `jj`, `guardian`, `web`, `capabilities`, `subagents`, `session-title`, `compaction`, and `work-context` become `@pi-tai/core`. Pi-specific chrome, preferences, and ACP projection belong to a separate client adapter and must not leak Pi dependencies back into core.

These leave the runtime path entirely: the `session_start` configuration reload (`config/register.ts:29`, superseded by I13 D4); Pi-owned configuration, credentials, model-catalog, trust, session, and execution authority; and the `PiTaiRegistrars` / `createPiTaiExtension` harness composition shell, which may be replaced by a thin ACP client bootstrap rather than deleted outright.

## Two structural blockers

### The runtime worker source-directory reach-in (resolved structural slice)

The worker now imports extension composition from `packages/pi-tai/pi-tai.ts` and reusable services from the stable `packages/pi-tai/core.ts` facade. Repository tests prohibit deep imports from apps, bins, and services. This removes the original source-directory blocker without claiming the broader `@pi-tai/core` package extraction is complete.

### `subagents/register.ts` must be dismantled

The registrar has been reduced from its historical size to roughly 700 lines, and dashboard rendering, lifecycle management, backend logic, catalogs, and workspace isolation now have explicit modules under `src/core/subagents`. It still combines twelve-tool declarations with registration wiring. Splitting those remaining concerns is honestly deferred until shared ACP declarations require it; doing so mechanically in this bounded structural slice would risk the preserved public tool contract.

Split along the seams already present: wiring, tool declarations, host projection, UI. Declare tools as data — a `tools/` module exporting `{ name, schema, handler }` — with `pi.registerTool` as one thin adapter over it. The ACP and Host surfaces then reuse the same declarations instead of reimplementing them, and client productization becomes adapter isolation rather than a rewrite.

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
- No application imports another application's source directory by relative path.
- `subagents/register.ts` is split along wiring, tool-declaration, projection, and UI seams, and tool declarations are data reusable by the ACP and Host surfaces.
