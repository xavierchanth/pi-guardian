# Terminal Pi-Tai Plugin Implementation Plan

## Status and scope

Implemented and manually accepted for progression to Stage 2. Session-title tuning may continue independently if real-model behavior needs adjustment.

This plan covers only the first product stage:

- reorganize the repository around a composable Pi-Tai plugin package;
- modernize the Pi package baseline;
- replace task context with `update_plan` work context;
- add independent automatic session naming;
- replace modes with Approval Guardian;
- make ANSI themes lifecycle-safe;
- prepare a tagged terminal release candidate.

It does not implement Pi-Tai Host, ACP, Tauri, local IPC, or mobile. Work stops for manual terminal acceptance before any of those begin.

## Architecture decisions

### Keep the repository root Git-installable

Pi resolves a Git package from the repository root and reads the root `package.json`. The root therefore remains the `pi-tai` distribution manifest even as the repository gains package and application directories.

The root manifest will point directly to the plugin entrypoint and themes:

```json
{
  "name": "pi-tai",
  "type": "module",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./packages/pi-tai/extension.ts"],
    "themes": ["./packages/pi-tai/themes"]
  }
}
```

This preserves:

```bash
pi install git:github.com/xavierchanth/pi-tai@v0.1.0
pi -ne -e . "<prompt>"
```

The root may become an npm workspace root when Host applications are added, but Stage 1 must not require npm workspace indirection for Pi resource discovery.

### Use one Pi extension composition root

`packages/pi-tai/extension.ts` is the single Pi-loaded entrypoint. It registers focused feature modules in deterministic order:

1. work context;
2. session naming;
3. Approval Guardian;
4. ANSI theme synchronization.

Pi already supplies the extension system. Pi-Tai will not build dynamic plugin discovery, a second event bus, or a general-purpose plugin framework. Each feature is a normal registrar with explicit dependencies so it can be unit tested and reused by the future hosted runtime.

Representative shape:

```ts
export interface PiTaiDependencies {
  loadConfig?: LoadPiTaiConfig;
  generateTitle?: GenerateTitle;
  queryTerminalPalette?: QueryTerminalPalette;
}

export function createPiTaiExtension(
  dependencies: PiTaiDependencies = createProductionDependencies(),
) {
  return async function registerPiTai(pi: ExtensionAPI) {
    const workContext = registerWorkContext(pi, dependencies);
    registerSessionNaming(pi, dependencies);
    registerGuardian(pi, { workContext });
    registerAnsiTheme(pi, dependencies);
  };
}

export default createPiTaiExtension();
```

The exact dependency object should remain small. Add a seam only when a production boundary needs a fake or when two features genuinely share state.

### Separate domain logic from Pi and TUI adapters

Each feature separates:

- pure domain types and validation;
- Pi event/tool wiring;
- persistence/reconstruction;
- optional TUI rendering;
- external model/process adapters.

Domain modules must not import `@earendil-works/pi-tui`. Headless operation and unit tests cannot depend on terminal components.

### Use complete snapshots for work context

`update_plan` tool results contain the complete goal and plan in both readable text and typed `details`. The active branch's latest valid tool result is authoritative in standalone terminal Pi.

Plan-item transition identity is the normalized `content` string in Stage 1 because the public schema has no item ID. A renamed item is treated as a new item. A new item cannot first appear as `completed`; it must appear as `in_progress` in an accepted prior snapshot.

The storage boundary is named `WorkContextStore`, but Stage 1 implements only `PiSessionWorkContextStore`. `BrokerWorkContextStore` belongs to the Host stage.

### Keep title generation independent

The title generator receives an explicitly resolved provider/model and thinking effort. It never receives the active work model as a fallback. Tests inject a fake generator and model registry; unit tests make no paid requests.

### Keep Guardian local and minimal

Pi-Tai reviews every agent-generated `bash` call with an isolated `openai-codex/codex-auto-review` session. The prompt evaluates exact authorization and semantic fidelity only. Built-in file tools use deterministic canonical workspace/temp boundaries; direct user shell and custom tools remain outside this policy.

### Use a dedicated Pi-Tai configuration file

Pi's documented extension API does not expose arbitrary namespaced settings as a stable typed extension API. Stage 1 therefore uses:

```text
~/.pi/agent/pi-tai.json
<project>/.pi/pi-tai.json
```

Project configuration is read only when `ctx.isProjectTrusted()` is true. Project values override global values through an explicit schema-aware merge. Guardian has no separate configuration surface.

Initial Pi-Tai configuration:

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

Unknown or invalid optional fields produce one concise warning and use safe defaults. Security-sensitive Guardian configuration remains fail-closed under Guardian's own rules.

## Target Stage 1 repository shape

```text
pi-tai/
├── package.json                 # Git-installable Pi distribution manifest
├── package-lock.json
├── tsconfig.json
├── AGENTS.md
├── LICENSE
├── README.md
├── docs/
│   ├── PRD.md
│   ├── IMPLEMENTATION_PLAN.md
│   ├── TERMINAL_PLUGIN_PLAN.md
│   ├── HOST_ARCHITECTURE.md
│   └── ACP_SCOPE.md
├── packages/
│   └── pi-tai/
│       ├── extension.ts         # deterministic composition root
│       ├── src/
│       │   ├── config/
│       │   │   ├── load.ts
│       │   │   ├── merge.ts
│       │   │   ├── paths.ts
│       │   │   └── schema.ts
│       │   ├── work-context/
│       │   │   ├── domain.ts
│       │   │   ├── persistence.ts
│       │   │   ├── register.ts
│       │   │   └── render.ts
│       │   ├── session-title/
│       │   │   ├── config.ts
│       │   │   ├── generate.ts
│       │   │   ├── normalize.ts
│       │   │   └── register.ts
│       │   ├── guardian/
│       │   │   └── register.ts
│       │   └── ansi-theme/
│       │       ├── color.ts
│       │       ├── query.ts
│       │       └── register.ts
│       └── themes/
│           ├── ansi-dark.json
│           └── ansi-light.json
└── tests/
    ├── helpers/
    │   ├── fake-extension-api.ts
    │   ├── fake-model-registry.ts
    │   ├── fake-session.ts
    │   └── fixtures.ts
    ├── unit/
    ├── integration/
    ├── repository/
    └── smoke/
```

Exact filenames may change during refactoring, but the composition/domain/adapter boundaries should remain.

Do not create empty `apps`, `bins`, `crates`, or `services` directories in Stage 1. Add them when their first executable or package is implemented.

## Tooling baseline

- Runtime: Node compatible with Pi and Guardian; currently Node 22.19 or newer.
- Package manager contract: npm, because Pi runs `npm install` for Git packages.
- Tests: Node's test runner with TypeScript type stripping, unless a proof shows a required unsupported syntax.
- Type checking: TypeScript with `noEmit`.
- Formatting/linting: add only one formatter/linter already suitable for the repository; do not block behavior work on a large style migration.
- Pi core imports are peer dependencies with the package-documented `"*"` range and compatible pinned dev dependencies for tests.
- Guardian uses Pi's built-in Codex provider and existing OAuth credentials, never the active work model or title model.

Required scripts:

```text
npm test
npm run test:unit
npm run test:integration
npm run typecheck
npm run check
npm run package:check
npm run smoke:isolated
```

`check` runs type checking, automated tests, repository assertions, and package validation. Paid model calls and `/dev/tty` access are forbidden in automated tests.

## Implementation phases

Every behavior phase follows red → green → refactor → checkpoint.

### Phase T0: freeze the current behavior boundary

#### Red

Add failing tests that describe only the package contract needed for reorganization:

- the root manifest references existing resources;
- the package imports only current `@earendil-works/*` Pi modules;
- `pi -ne -e .` loads only this distribution;
- print/RPC-style loading cannot start terminal polling;
- expected themes are discoverable;
- no committed `.DS_Store`, temporary clone, generated dependency, or machine-local file is tracked.

The first isolated load may fail because the current package still imports `@mariozechner/*`. Record the expected failure before changing imports.

#### Green

- Add `type: module`, package keywords, engine constraints, scripts, TypeScript configuration, and lockfile.
- Replace legacy Pi package imports with `@earendil-works/*` imports.
- Add current Pi packages as peers/dev dependencies according to Pi package guidance.
- Add test helpers without changing feature behavior.
- Remove the temporary README line and obsolete accidental artifacts if tracked.

#### Acceptance

- Current Pi-Tai loads with only this distribution enabled.
- Tests and type checking run from a clean install.
- Headless package loading performs no TTY query.

#### Checkpoint

```text
build: establish the modern Pi package baseline
```

### Phase T1: move to the composed plugin layout

This phase is primarily structural and should preserve observable behavior except for fixing startup lifecycle violations required by the baseline tests.

#### Red

Add tests proving:

- the root manifest exposes exactly one extension entrypoint and two themes;
- the composition root registers each feature exactly once and in documented order;
- an injected fake dependency reaches only the feature that needs it;
- package resources still resolve after `npm pack --dry-run` and a temporary local install;
- the Git-package root remains the resource base.

#### Green

- Create `packages/pi-tai/extension.ts`.
- Move existing extensions and themes under `packages/pi-tai`.
- Initially adapt existing factories behind focused registrar functions; avoid behavior rewrites in the same step.
- Point the root Pi manifest at the composition root and relocated themes.
- Establish the test helper for a fake `ExtensionAPI` event registry.

#### Refactor

- Remove circular imports and global mutable singletons.
- Keep production dependency construction in one module.
- Do not create a generic plugin registry or dynamic loader.

#### Acceptance

- Terminal, print, JSON, and RPC package-load smoke tests behave as before.
- A tagged Git checkout would remain directly installable from its root.

#### Checkpoint

```text
refactor: organize Pi-Tai as composed plugins
```

### Phase T2: shared trusted configuration

#### Red

Add unit tests for:

- missing global and project files;
- valid global configuration;
- trusted project overrides;
- ignored untrusted project configuration;
- nested schema-aware merging;
- invalid JSON and invalid fields;
- provider/model fields remaining independent;
- one warning per invalid configuration revision;
- path resolution through Pi's `getAgentDir()` and `CONFIG_DIR_NAME` exports.

#### Green

- Implement the `pi-tai.json` loader and schema.
- Read configuration on `session_start` and replacement/reload lifecycles.
- Expose immutable parsed configuration to feature registrars.

#### Acceptance

- Global configuration works in all modes.
- Project-local configuration never loads before project trust.
- No extension reparses Pi-Tai configuration independently.

#### Checkpoint

```text
feat(config): add trusted Pi-Tai configuration
```

### Phase T3: structured work context

#### Red

Add unit and integration tests for:

- schema acceptance for goal, explanation, plan status, and optional priority;
- no more than one `in_progress` item;
- complete replacement rather than merge;
- normalized-content transition identity;
- rejection of a new or prior `pending` item becoming immediately `completed`;
- an `in_progress` item becoming `completed`;
- empty plans for simple work;
- readable complete snapshot text;
- typed complete snapshot details;
- reconstruction from only the current branch;
- reconstruction after `session_tree`;
- resume and reload reconstruction;
- state still reconstructing after compaction entries exist;
- no fenced `task-context` instructions or assistant-message scraping.

#### Green

- Register `update_plan` with `typebox` and `StringEnum` where required for provider compatibility.
- Store every accepted complete snapshot in tool-result details.
- Reconstruct from `ctx.sessionManager.getBranch()` on session start and tree changes.
- Add original, concise prompt guidelines explaining when planning is and is not needed.
- Add a responsive two-line TUI widget below the editor with full-width goal and progress/current-step lines.
- Keep tool results compact by default and show the complete checklist when expanded.
- Add the read-only `/plan-status` full-plan view.
- Expose the current immutable work context to the Guardian adapter.

#### Refactor

- Keep transition validation and reconstruction pure.
- Return cloned/frozen state from the store boundary.
- Keep renderers out of persistence tests.

#### Acceptance

- Multi-stage terminal work creates and maintains a useful plan.
- Simple work can proceed without a plan.
- Resume, compaction, and branch navigation select the correct snapshot.

#### Checkpoint

```text
feat(work-context): replace task blocks with update_plan
```

### Phase T4: independent session naming

#### Red

Add tests for:

- independent provider, model, and effort parsing;
- configured model lookup through a fake registry;
- no tool definitions in the naming request;
- a small output budget;
- naming after the first meaningful user prompt;
- no overwrite of a manual/existing name;
- one automatic attempt by default;
- no implicit active-work-model fallback;
- deterministic heuristic fallback;
- quote, punctuation, whitespace, and word-limit normalization;
- cancellation and provider failure not interrupting the work turn;
- `pi.setSessionName()` receiving the final normalized title.

#### Green

- Implement title configuration, generation, normalization, and registration modules.
- Use Pi's configured authentication for only the explicitly resolved title model.
- Persist through `pi.setSessionName()`.

#### Acceptance

- Fake-model integration is deterministic and free.
- A manually configured Luna model can be tested without changing the active work model.
- Missing Luna configuration uses only the heuristic fallback.

#### Checkpoint

```text
feat(session-title): name sessions with an independent model
```

### Phase T5: Approval Guardian composition

#### Red

Add integration tests for:

- every agent-generated `bash` action receiving a fresh review;
- no Pi-Tai mode commands or prompts;
- canonical path containment and symlink escapes;
- strict allow/deny parsing and reviewer failure modes;
- role-preserved exact authorization evidence;
- broad goals and failures not expanding authorization;
- exact-action TUI allow-once and noninteractive fail-closed behavior;
- reviewer isolation from project resources and tools.

#### Green

- Add local policy, reviewer, canonical paths, and registration modules.
- Resolve the internal auto-review model from Codex model metadata and Pi's main runtime.
- Remove the external Guardian dependency, settings, command, and stale documentation.
- Remove the old modes, classifiers, commands, and legacy Guardian prompt.

#### Refactor

- Keep the prompt free of examples, command taxonomy, and automatic exceptions.
- Keep one-shot TUI approval inside the current tool handler with no reusable state.

#### Acceptance

- Pi-Tai has one guarded automatic workflow.
- No legacy mode is selectable or documented.
- Guardian is fail-closed and receives useful task evidence.

#### Checkpoint

```text
feat(guardian): replace access modes with Approval Guardian
```

### Phase T6: lifecycle-safe ANSI themes

#### Red

Add tests for:

- no query, child process, timer, or `/dev/tty` access during factory evaluation;
- no terminal work in print, JSON, or RPC mode;
- query startup only from a TUI `session_start`;
- valid OSC 11 parsing and luminance classification;
- dark/light theme selection from configuration;
- no overlapping poll requests;
- idempotent cleanup on shutdown, reload, new, resume, and fork;
- child cancellation and silent unsupported-terminal fallback.

#### Green

- Move terminal querying behind an injected adapter.
- Start it only when `ctx.mode === "tui"` during `session_start`.
- Track the active child and timer explicitly.
- Stop both during `session_shutdown`.
- Preserve `ansi-dark` and `ansi-light` theme names.

#### Acceptance

- Interactive Pi follows terminal background changes.
- Every headless mode remains terminal-independent.
- Reloading does not duplicate pollers.

#### Checkpoint

```text
fix(ansi-theme): scope palette polling to TUI sessions
```

### Phase T7: remove legacy material and validate distribution

#### Red

Add repository/package assertions for:

- no `extensions/modes` or fenced task-context implementation;
- no legacy `@mariozechner` imports;
- no legacy Guardian policy or prompt remnants;
- no obsolete permission settings documentation;
- no unintended files in the package manifest/tarball;
- root Git installation paths resolving after a clean dependency install.

#### Green

- Delete legacy code and stale references to retired implementations.
- Rewrite README and configuration documentation.
- Document Git-tag install and explicit upgrade commands.
- Remove or incorporate stale `TODO.md` and `SETTINGS.md` content.

#### Final automated verification

```bash
npm ci
npm run check
npm run package:check
npm run smoke:isolated
```

`smoke:isolated` uses a fake/local model fixture or a startup-only RPC exchange and loads only this distribution. It must not call a paid model. The required real-agent command is reserved for manual acceptance:

```bash
pi -ne -e . "Reply with exactly: pi-tai-loaded"
```

Additional automated tests exercise print, JSON, and RPC loading without paid model calls.

#### Checkpoint

```text
docs: prepare the terminal Pi-Tai release candidate
```

### Phase T8: manual terminal acceptance gate

Stop and provide the checklist already defined in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). Do not scaffold Tauri, Host, ACP, or mobile implementation while waiting for approval.

## Checkpoint order

Expected reviewable stack:

```text
build: establish the modern Pi package baseline
refactor: organize Pi-Tai as composed plugins
feat(config): add trusted Pi-Tai configuration
feat(work-context): replace task blocks with update_plan
feat(session-title): name sessions with an independent model
feat(guardian): replace access modes with Approval Guardian
fix(ansi-theme): scope palette polling to TUI sessions
docs: prepare the terminal Pi-Tai release candidate
```

A phase may be split if its tests and implementation form independently useful review units. Do not squash security-sensitive Guardian integration into unrelated repository movement.

## Known risks and mitigations

| Risk | Mitigation |
|---|---|
| Moving the Pi package under `packages/` breaks Git installation | Keep the root `pi` manifest and test resources from a clean root install before feature work. |
| A custom plugin framework competes with Pi | Use one explicit composition root and ordinary registrar functions only. |
| Guardian's package entrypoint changes | Pin a compatible version and exercise factory loading in integration/package tests. |
| Guardian cannot see the current plan | First assert readable tool results in its branch transcript; pursue a narrow upstream context provider only if required. |
| Work-context state follows the wrong branch | Reconstruct only from `getBranch()` and test `session_tree`, resume, fork, and compaction. |
| Title generation accidentally uses the expensive work model | Require explicit provider/model lookup and test heuristic-only fallback. |
| ANSI polling leaks into ACP/Host later | Treat every non-TUI mode as forbidden and test factory evaluation separately from session start. |
| Root and future workspace packaging diverge | Keep root Git-install contract in repository tests before introducing applications. |

## Start readiness

Implementation can begin with Phase T0. The exact Luna provider/model ID is not required until the real-model manual check. Guardian's potential context-provider change does not block baseline, repository reorganization, configuration, work-context, title, or ANSI work.

Before Guardian manual acceptance, the user must choose a Guardian reviewer provider/model independently from Luna and the active work model, or explicitly accept Guardian's documented default reviewer.
