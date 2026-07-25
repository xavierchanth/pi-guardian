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

### The runtime worker reaches into the extension's source directory

`services/pi-runtime/src/pi-runtime.ts:32-37` imports six modules from `packages/pi-tai` by relative path (`../../../packages/pi-tai/pi-tai.ts`, plus `src/capabilities/controller.ts`, `src/config/register.ts`, `src/work-context/persistence.ts`, `src/jj/repository-enrollment.ts`, `src/jj/session-workspace.ts`).

This violates `REPOSITORY.md` — "No top-level application reaches into another application's source directory" — and is the concrete mechanism by which the worker acquires the filesystem configuration authority that I13 D4 removes. It is also the seam extraction has to cut: these six imports are approximately the real surface area of `@pi-tai/core` as the worker uses it today.

Resolve it as part of extraction rather than by adding a package alias, so the import list is forced to become an intentional public surface instead of an accident of path depth. The extraction is cheaper than it looks: `jj/`, `workspaces/`, and the non-`register` half of `concurrency/` — roughly 65 files — already have no Pi imports at all, and several remaining couplings are type-only or a single helper (`getAgentDir`, `CONFIG_DIR_NAME`, `truncateToWidth`, `AssistantMessage`).

### `subagents/register.ts` must be dismantled

The file is approximately 2,190 lines. It mixes dependency wiring, tool schema definitions, Host projection publishing, and a TUI widget; `:166` is a single filter expression spanning three nested ternaries over workspace phases. **This is the file that must be dismantled when the Pi extension shell goes away**, so every tool added to it is deferred cost.

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
