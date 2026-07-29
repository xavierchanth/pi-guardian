# I17 — Context transfer under `/export` and `/import`

**Status:** Planned  
**Depends on:** I00. Uses no I13 checkpoint beyond what already ships.

## Outcome

A user who has driven a session to a useful state types `/export`, receives a short ID, pastes
`/import <ID>` into a fresh session on the same machine, and the new session opens already knowing
the goal, the settled decisions and why, the current state, the next step, and what is still
ambiguous.

The two verbs are the bare, memorable ones. `/export` and `/import` are upstream Pi built-ins, so
Pi-Tai registers canonical `context-export` and `context-import` commands and reaches the bare names
through a TUI editor alias that rewrites the submission before Pi's built-in dispatch sees it. The
built-in file behavior is preserved exactly whenever the argument is a path-like `.html` or `.jsonl`
value.

Export is **out-of-band**: it summarizes the current branch through the public `generateSummary`
entry point and writes nothing into the session. No literal session fork, no custom entry, no
message — the exporting session's context window is byte-for-byte what it would have been had the
user never run the command.

Import is **in-band and deliberate**: it injects one persistent custom message framed as reference
material and triggers a model turn whose only instruction is to concisely restate what it now knows.

## Product framing

This is a terminal-client affordance in the same family as I15 and I16: it lives in the Pi adapter,
spends the user's tokens only on explicit invocation, and takes no machine authority. Unlike I16,
which deliberately leaves no trace, I17's import side deliberately *does* leave a trace — a durable
transfer that survives reload is the entire point.

Under Product principle 4 (machine capabilities remain local) the artifact store is machine-scoped
and never implied to be portable. Under principle 10 (no automatic publication) nothing leaves the
machine: the artifact is a local file and the ID is a local handle, not a URL.

## Settled decisions

Decisions are numbered `D<n>` and referenced by implementation checkpoints. Do not reopen without
new evidence.

| ID | Decision | Rationale |
|---|---|---|
| D1 | Canonical commands are `context-export` and `context-import`. | Upstream intercepts `/export` and `/import` in the TUI submit handler before extension dispatch; an extension command with those names is unreachable. |
| D2 | Bare `/export` and `/import` are reached by a TUI editor `onSubmit` rewrite, not by a name collision. | The rewrite is the only seam that runs before upstream's `text === "/export"` comparison. |
| D3 | A path-like first argument ending in `.html` or `.jsonl` passes through to the built-in unchanged. | Users who already rely on file export must keep it. Path-likeness is a purely lexical test on the first argument. |
| D4 | Export summarizes the current branch out-of-band with the public `generateSummary`. | Public, versioned entry point; already the summarizer Pi trusts for compaction, so quality tracks upstream. |
| D5 | Export produces zero model-visible pollution and performs no session fork. | The exporting session must be usable afterwards exactly as before. A fork would create a second session file and confuse resume. |
| D6 | The artifact is summary-only and versioned. | No raw transcript, no tool output, no message array. Keeps the file small, reviewable, and free of secrets that only ever appeared in tool results. |
| D7 | IDs are 8 characters of Crockford base32, validated before touching the filesystem. | Short enough to retype, unambiguous under `I`/`L`/`O`/`U` confusion, and a closed character set makes path-traversal rejection total. |
| D8 | Storage lives under `getAgentDir()/pi-tai/context-exports`, directories `0700`, files `0600`, written atomically. | Matches the existing `getAgentDir()/pi-tai/agents` convention and the atomic-rename discipline in `isolation/registry.ts`. |
| D9 | Export output is a `/import <ID>` line, notified and copied to the clipboard. | The user's next action is pasting it into another terminal; make that one keystroke. |
| D10 | Import injects a persistent custom message framed as reference material and triggers a turn. | `sendMessage` with `triggerTurn` is the only mechanism that is durable, enters context, and starts a turn in one call. |
| D11 | The triggered turn asks only for a concise restatement of goal, decisions and rationale, state, next step, and ambiguities. | Confirms transfer fidelity and gives the user a correction point before any work starts. |
| D12 | v1 scope: one user, one machine, one-shot export, active session model, automatic retention, no new configuration. | Adding a `SessionPolicy` block would force a matching Rust resolver, provenance descriptor, and differential fixture for a feature whose defaults nobody has yet wanted to change. |

## Grounded API surface

Every mechanism below was verified against `@earendil-works/pi-coding-agent@0.80.10`, the version
pinned in the repository root `package.json`. Implementation must re-verify against the pinned
version at the time of work.

| Need | Mechanism | Evidence |
|---|---|---|
| Canonical commands | `ExtensionAPI.registerCommand(name, {description, handler})`; hyphenated names are already in use. | `core/extensions/types.d.ts` `RegisteredCommand`; `model-profiles/register.ts` registers `profile` and `effort`; upstream ships `scoped-models`. |
| Proof that `/export` is unreachable | The interactive submit handler tests `text === "/export" || text.startsWith("/export ")` and returns before any extension dispatch. | `modes/interactive/interactive-mode.js` submit handler; extension commands only reach `session.prompt(text)` far below. |
| Built-in argument semantics to preserve | `getPathCommandArgument(text, "/export")` returns the first whitespace-delimited token, or the contents of a leading matched quote; `undefined` for a bare command. `.jsonl` selects JSONL, anything else selects HTML. `/import` requires an argument and errors with `Usage: /import <path.jsonl>` otherwise. | `handleExportCommand`, `handleImportCommand`, `getPathCommandArgument` in `interactive-mode.js`. |
| Alias seam | `ctx.ui.setEditorComponent(factory)`; the host then assigns `newEditor.onSubmit = this.defaultEditor.onSubmit`, and the base `Editor.submitValue()` calls `this.onSubmit(result)` on the trimmed, paste-expanded text. | `setCustomEditorComponent` in `interactive-mode.js`; `submitValue` in `@earendil-works/pi-tui` `components/editor.js`. |
| Out-of-band summarization | `generateSummary(currentMessages, model, reserveTokens, apiKey, headers?, signal?, customInstructions?, previousSummary?, thinkingLevel?, streamFn?, env?)`, exported from the package root. | `core/compaction/compaction.d.ts`; re-exported in `dist/index.d.ts`. |
| Exact model-visible context | `buildSessionContext(entries, leafId)` over `ctx.sessionManager.getEntries()` and `getLeafId()`. Compaction- and branch-aware. The free function is the supported route; the method form is not on `ReadonlySessionManager`'s `Pick` list. | `core/session-manager.d.ts`; `ReadonlySessionManager` `Pick` list. |
| Model and auth | `ctx.model`, `ctx.modelRegistry.getApiKeyAndHeaders(model)` returning `{ok, apiKey, headers, env}`; `pi.getThinkingLevel()`. | `core/model-registry.d.ts`; the same handshake as `session-title/generate.ts`. |
| Reserve-token budget | `DEFAULT_COMPACTION_SETTINGS.reserveTokens` is `16384`. | `core/compaction/compaction.js`. |
| Durable, in-context injection | `pi.sendMessage({customType, content, display, details}, {triggerTurn: true})` writes a `custom_message` entry; `buildSessionContext` converts its content to a user message. | `ExtensionAPI.sendMessage`; `CustomMessageEntry` doc comment "The content is converted to a user message in buildSessionContext()". |
| Import rendering | `pi.registerMessageRenderer(customType, renderer)`. | `ExtensionAPI.registerMessageRenderer`. |
| Clipboard | `copyToClipboard(text)` exported from the package root. | `dist/index.d.ts` line 30; `utils/clipboard.d.ts`. |
| Artifact root | `getAgentDir()` exported from the package root. | `dist/index.d.ts` line 2. |

### The one non-obvious mechanism

`Editor` declares `onSubmit` as a **class field**, so `super()` installs it as an own data property
on every instance. A subclass prototype accessor would be shadowed by that own property and never
run. The alias must therefore install an accessor on the instance, after `super()`:

```ts
let host: ((text: string) => void) | undefined;
Object.defineProperty(this, "onSubmit", {
  configurable: true,
  enumerable: true,
  get: () => (text: string) => host?.(rewriteSubmission(text)),
  set: (handler) => { host = handler; },
});
```

The host writes through the setter (`newEditor.onSubmit = this.defaultEditor.onSubmit`) and the base
class reads through the getter (`this.onSubmit(result)`). Nothing upstream compares `onSubmit` by
identity, so returning a fresh closure per read is safe. A unit test must pin this, because it is
the single assumption that silently stops working if upstream converts the field to an accessor or
starts caching the handler.

## Command and editor surface

### Canonical commands

| Command | Argument | Behavior |
|---|---|---|
| `/context-export` | optional free-text notes | Summarize the current branch, write an artifact, report and copy `/import <ID>`. |
| `/context-import` | required ID | Load the artifact, inject it as reference material, trigger a restatement turn. |

Both are mode-agnostic and work in RPC and headless modes. Only the alias is TUI-only.

### Alias rewrite contract

`rewriteSubmission(text: string): string` is pure, total, and idempotent. It runs on the already
trimmed, paste-expanded submission — the same string upstream would have compared against.

1. If `text` is neither `"/export"`, `"/export "`-prefixed, `"/import"`, nor `"/import "`-prefixed,
   return it unchanged. This matches upstream's own test exactly, so `/exports`, an indented
   `/export`, and a multi-line message whose second line is `/export` are all untouched.
2. Compute `firstPathArgument(text, command)` — a faithful re-implementation of upstream's
   `getPathCommandArgument`, including its leading-quote handling and its `undefined` results for a
   bare command, an argument-free trailing space, and an unterminated quote.
3. For `/export`: if the argument exists and, lowercased, ends in `.html` or `.jsonl`, return `text`
   unchanged (D3). Otherwise return `"/context-export"` followed by the original remainder verbatim.
4. For `/import`: if the argument exists and is path-like — lowercased suffix `.jsonl`, or it
   contains a path separator, or it starts with `.`, `/`, or `~` — return `text` unchanged.
   Otherwise return `"/context-import"` followed by the original remainder verbatim.
5. Text already beginning `/context-export` or `/context-import` is returned unchanged.

Two consequences are accepted and documented rather than engineered around:

- The editor's up-arrow history records the rewritten text, because upstream calls `addToHistory`
  after `onSubmit` on the value it received. `/context-export notes` in history still works.
- Autocomplete offers upstream's `export` and `import` alongside Pi-Tai's `context-export` and
  `context-import`. The bare names keep their upstream descriptions in the menu.

### Editor composition

`ctx.ui.setEditorComponent` accepts exactly one factory, and Pi-Tai already spends it on
`ResponseEditor` — and only when an external editor command is configured. The alias must therefore
compose with it rather than register a second component.

Introduce a single editor registrar that owns the one `setEditorComponent` call:

- `withCommandAliases(Base)` is a class-factory mixin over a `CustomEditor` subclass constructor. It
  installs the instance accessor described above and applies `rewriteSubmission`.
- The registrar resolves `SettingsManager.getExternalEditorCommand()` exactly as
  `response-editor/register.ts` does today. Base class is `ResponseEditor` when a command is
  configured, `CustomEditor` otherwise.
- The composed class is always installed in TUI mode, so the alias no longer depends on the user
  having configured an external editor. This is a behavior change for users with no external editor
  configured: they gain a custom editor component where they previously had the default one. The
  mixin adds no input handling of its own, so the observable difference is the alias alone.

`PiTaiRegistrars.responseEditor` is renamed to `PiTaiRegistrars.editor` and keeps its ordinal
position in the composition root. `tests/unit/composition.test.ts` is updated in the same change.

## Storage schema

Root: `join(getAgentDir(), "pi-tai", "context-exports")`, created `recursive: true, mode: 0o700`.
File: `<ID>.json`, written to `<ID>.json.<pid>.tmp` with `mode: 0o600` and then renamed.

```jsonc
{
  "version": 1,
  "id": "A1B2C3D4",
  "createdAt": "2026-07-29T12:34:56.789Z",
  "summary": "…the generated narrative, and nothing else…",
  "notes": "optional verbatim user notes from the command argument",
  "source": {
    "cwd": "/abs/path/to/project",
    "sessionId": "…",
    "model": { "provider": "anthropic", "id": "claude-…" },
    "piTaiVersion": "0.1.0"
  }
}
```

Invariants:

- **Summary-only (D6).** The record type has no field capable of holding messages, entries, tool
  results, or file contents. A test asserts the serialized JSON contains no `messages`, `entries`,
  or `content` key.
- **Self-identifying.** `record.id` must equal the filename stem; a mismatch is corruption, not a
  rename to be tolerated.
- **Versioned.** An unknown `version` is refused with a message naming the supported version. New
  fields that older readers can ignore do not bump the version; changes to the meaning of `summary`
  or the identity of `id` do.
- **Path-closed.** `artifactPath(root, id)` validates the ID against
  `/^[0-9A-HJKMNP-TV-Z]{8}$/` and then asserts `dirname(resolve(path)) === resolve(root)`, the same
  belt-and-braces pattern as `concurrency/paths.ts`.

### Identifier

Generated from `crypto.randomBytes(5)` — 40 bits, exactly 8 Crockford base32 characters, alphabet
`0123456789ABCDEFGHJKMNPQRSTVWXYZ`. On collision with an existing file, regenerate; after 5
collisions, fail loudly rather than overwrite.

`normalizeContextId(input)` uppercases, strips whitespace and `-`, folds `I` and `L` to `1` and `O`
to `0`, then validates. `U` is not in the alphabet and is not folded — it is rejected.

### Retention

Automatic and unconfigurable in v1 (D12). After each successful export, prune the directory to
entries younger than 30 days **and** to the 50 most recent by `createdAt`. Unparseable files are
counted for the cap and pruned by age using mtime. A prune failure never fails the export; it
degrades to a warning notification.

## Flows

### Export

1. Snapshot `ctx.sessionManager.getEntries()` and `getLeafId()` once, up front, so a concurrent turn
   cannot shift the branch mid-summarization. Do not block on `ctx.isIdle()`.
2. `buildSessionContext(entries, leafId).messages`. Empty → notify `Nothing to export yet.` and stop.
3. Resolve `ctx.model`; undefined → error notify and stop.
4. `ctx.modelRegistry.getApiKeyAndHeaders(model)`; `!auth.ok` → error notify with `auth.error`.
5. Build custom instructions: a fixed context-transfer focus naming the five facets of D11, plus the
   user's notes appended as additional focus when present.
6. Call `generateSummary` positionally — the signature has no options object, and `env` is the
   twelfth parameter, so `previousSummary` and `streamFn` must be passed as `undefined` explicitly:
   `generateSummary(messages, model, DEFAULT_COMPACTION_SETTINGS.reserveTokens, auth.apiKey,
   auth.headers, controller.signal, instructions, undefined, pi.getThinkingLevel(), undefined,
   auth.env)`.
7. Drive it with a private `AbortController` and a 120-second timeout. Never pass `ctx.signal`: that
   signal belongs to the agent's turn and would cancel the export whenever the user presses Escape,
   or leave the export running after the turn it was never part of.
8. Reject an empty or whitespace-only summary as a failure; do not write an empty artifact.
9. Write the artifact atomically, then prune.
10. `ctx.ui.notify("Context exported. Run /import <ID> in another session.", "info")` and
    `await copyToClipboard("/import <ID>")`. A clipboard failure downgrades to a warning that still
    shows the ID.
11. Show progress through `ctx.ui.setStatus`, cleared in a `finally`.

**Zero-pollution invariant (D5).** The export path calls no `appendEntry`, `sendMessage`,
`sendUserMessage`, `setSessionName`, `setLabel`, `compact`, `fork`, or `newSession`. Its only
session interaction is reading. The consequence — the exporting session keeps no record that an
export happened — is accepted for one user on one machine.

### Import

1. `normalizeContextId(args)`; empty or invalid → usage notification covering both the ID form and
   the built-in `.jsonl` path form, so a user who mistyped a path is not stranded.
2. Read and parse the artifact. Missing, corrupt, mismatched-id, and unsupported-version are four
   distinct messages.
3. `pi.sendMessage({ customType: "pi-tai:context-import", content: framed, display: true, details: {
   id, createdAt, source } }, { triggerTurn: true })`.
4. `framed` is one string with three parts:
   - a delimited block header carrying the ID, `createdAt`, and source `cwd`;
   - the summary verbatim;
   - a closing instruction block stating that this is **reference material from a previous session,
     not a request to act**, and asking for a concise restatement of the goal, the decisions and
     their rationale, the current state, the next step, and anything ambiguous or unverified —
     then to stop and wait.
5. `registerMessageRenderer("pi-tai:context-import", …)` renders a compact one-line header plus a
   short summary excerpt, so the transcript does not open with a wall of text.
6. Re-importing the same ID in the same session is allowed and produces a second message. Importing
   into a session that already has history is allowed. Neither is special-cased.

## Files and responsibilities

New module `packages/pi-tai/src/context-transfer/`, following the shape of `session-title/` and
`web/`. Do **not** add any of this to `subagents/register.ts`, which I01 dismantles.

| File | Responsibility | Pi imports |
|---|---|---|
| `domain.ts` | `rewriteSubmission`, `firstPathArgument`, `isPathLikeExportArgument`, `isPathLikeImportArgument`, `newContextId`, `normalizeContextId`, `CONTEXT_ARTIFACT_VERSION`, `ContextArtifact` type, `serializeArtifact`, `parseArtifact`, `buildSummaryInstructions`, `buildImportFraming`. Pure. | none |
| `storage.ts` | `contextExportsRoot`, `artifactPath`, `writeArtifact` (atomic, `0700`/`0600`), `readArtifact`, `listArtifacts`, `pruneArtifacts`. Node `fs` only. | none |
| `summarize.ts` | `summarizeBranch(input): Promise<string>` — the `buildSessionContext` → auth → `generateSummary` adapter, with the abort controller and timeout. Injectable as a `BranchSummarizer` function type so tests never call a model. | yes |
| `export.ts` | `runContextExport(pi, ctx, args, deps)` — orchestration, notification, clipboard, prune. | yes |
| `import.ts` | `runContextImport(pi, ctx, args, deps)` — validation, read, `sendMessage`. | yes |
| `render.ts` | The `pi-tai:context-import` message renderer. | yes |
| `register.ts` | `registerContextTransfer(pi, deps)` — the two `registerCommand` calls and the renderer registration. | yes |
| `index.ts` | Barrel. | — |

Changed files:

| File | Change |
|---|---|
| `packages/pi-tai/src/editor/alias.ts` (new) | `withCommandAliases(Base)` mixin and the instance-accessor installation. |
| `packages/pi-tai/src/editor/register.ts` (new) | The single `setEditorComponent` owner; composes `ResponseEditor` or `CustomEditor` with the mixin. |
| `packages/pi-tai/src/response-editor/register.ts` | Deleted; its settings resolution moves into `editor/register.ts`. `editor.ts`, `command.ts`, and `document.ts` are untouched. |
| `packages/pi-tai/pi-tai.ts` | `responseEditor` registrar renamed to `editor`; new `contextTransfer` registrar added after `webTools`. |
| `tests/unit/composition.test.ts` | Registrar list and order updated. |

`deps` carries `{ agentDir, summarizer, clock, idFactory, clipboard }` so every I/O and
nondeterminism source is injectable, matching how `PiTaiRuntime` already injects `titleGenerator`
and `notificationSender`.

## Migration constraint

Keep `domain.ts` and `storage.ts` free of `@earendil-works/*` imports so only `summarize.ts`,
`export.ts`, `import.ts`, `render.ts`, and `register.ts` are Pi-specific, per I01's core/adapter
split. Under ACP the equivalent is an available-command plus a client-rendered result, and the
editor alias becomes a client-side input transform — the same split.

## Failure behavior

Every failure is a notification. Nothing in this initiative throws into a turn, and nothing partially
written survives.

| Condition | Behavior |
|---|---|
| `/context-export` with no context yet | `Nothing to export yet.` info; no artifact. |
| No active model | Error notification naming the missing model; no artifact. |
| Auth resolution fails | Error notification carrying `auth.error`; no artifact. |
| Summarizer error, empty result, or 120 s timeout | Error notification; no artifact; no temp file left behind. |
| Artifact write fails | Error notification; temp file removed; no partial `<ID>.json`. |
| Clipboard copy fails | Warning notification that still shows `/import <ID>`; export is a success. |
| Prune fails | Warning notification; export is a success. |
| ID collision 5 times | Error notification; no overwrite. |
| `/context-import` with no argument | Usage notification covering both the ID form and the `.jsonl` path form. |
| Malformed ID | `Not a context-export ID: <input>.` |
| Unknown ID | `No context export with ID <ID>.` |
| Corrupt or id-mismatched artifact | `Context export <ID> is unreadable.`; no message sent. |
| Unsupported `version` | Message naming the file's version and the supported version; no message sent. |
| `/export ./out.html`, `/export "my notes.jsonl"` | Passthrough; upstream behavior verbatim. |
| Alias mixin cannot install its accessor | Fail closed: the editor still works, the bare names fall through to upstream, and a one-time warning notification names `/context-export`. |

## Tests

### `tests/unit/context-transfer.test.ts`

Rewrite table, at minimum: `/export`; `/export notes about the parser`; `/export ./out.html`;
`/export out.JSONL`; `/export "my notes.html"`; `/export "unterminated`; `/exports`; `  /export`
(pre-trimmed by the caller, so unchanged text in, unchanged text out); a two-line message whose
first line is `/export`; `/context-export x` (idempotent); `/import A1B2C3D4`;
`/import ./session.jsonl`; `/import ~/s.jsonl`; `/import`.

Identity: charset and length of 1000 generated IDs; `normalizeContextId` folds `i`, `l`, `o`, strips
`-`, uppercases; rejects `U`, 7 and 9 characters, and `../../../etc/passwd`.

Artifact: round-trip; unknown version rejected; id/stem mismatch rejected; serialized JSON contains
no `messages`, `entries`, or `content` key.

Prompts: `buildSummaryInstructions` names all five facets of D11 and appends notes when present;
`buildImportFraming` contains the reference-material framing and the restatement request and embeds
the summary verbatim.

Alias: with a fake `TUI`/`EditorTheme`/`KeybindingsManager`, assert
`Object.getOwnPropertyDescriptor(editor, "onSubmit")?.get` is defined, that assigning a spy and then
invoking `editor.onSubmit("/export notes")` delivers `/context-export notes` to the spy, and that
`/export a.html` arrives unchanged.

Storage: in a temp `agentDir`, assert directory mode `0700` and file mode `0600` (skipped on
`win32`), that no `.tmp` remains, read-back equality, `ENOENT` handling, and that `pruneArtifacts`
drops by both age and count while keeping the newest.

### `tests/integration/context-transfer.test.ts`

Using the fake-host pattern from `tests/repository/agent-tools.test.ts`, with an injected summarizer:

- `/context-export` writes exactly one artifact, copies `/import <ID>`, and records **zero**
  `appendEntry`, `sendMessage`, and `sendUserMessage` calls. This is the D5 regression test.
- `/context-import <ID>` sends exactly one message with `customType: "pi-tai:context-import"`,
  `display: true`, `triggerTurn: true`, and content containing both the summary and the framing.
- Unknown ID, corrupt file, and unsupported version each notify and send nothing.
- A summarizer rejection leaves the directory empty.
- Export followed by import in a second fake host round-trips the summary.

### `tests/unit/composition.test.ts`

Updated registrar list and order, including the new `contextTransfer` entry.

### `tests/repository/package-contract.test.ts`

Assert `context-transfer/domain.ts` and `context-transfer/storage.ts` contain no
`@earendil-works/` import, pinning the I01 core/adapter split.

## Documentation

| Document | Change |
|---|---|
| `docs/roadmap/README.md` | I17 row in the index, node and edge in the dependency graph, and a session-affordances lane entry. |
| `README.md` | A `### Session context transfer` subsection under "Included plugins": what `/export` and `/import` do, that `.html`/`.jsonl` arguments still reach the built-in, and where artifacts live. |
| `SETTINGS.md` | One line stating that context transfer has no configuration in v1 and why. |
| `docs/architecture/CLIENTS.md` | One paragraph under "Pi terminal client" recording that the bare-name alias is a client-adapter input transform and that the canonical commands are the portable surface. |

`docs/PRODUCT.md` and `docs/architecture/SESSIONS.md` do not change: the artifact is client-local
state, not canonical session data.

## Sequencing and delegation

Checkpoints are independently reviewable. 1 and 2 are parallel; 3 depends on 1; 4 depends on 1;
5 depends on 3 and 4; 6 depends on 5.

| # | Checkpoint | Exit |
|---|---|---|
| 1 | `domain.ts` and its unit tests | Rewrite table, ID, artifact, and prompt tests pass. No Pi import. |
| 2 | `storage.ts` and its unit tests | Atomic write, modes, path closure, prune. No Pi import. |
| 3 | Editor composition: `editor/alias.ts`, `editor/register.ts`, `pi-tai.ts` rename, `composition.test.ts` | `/export` reaches a stubbed alias target; `ResponseEditor` behavior unchanged when an external editor is configured. |
| 4 | `summarize.ts`, `export.ts`, `import.ts`, `render.ts`, `register.ts` | Integration tests pass against an injected summarizer. |
| 5 | Documentation and index updates | `check-docs.mjs` clean. |
| 6 | Live verification | The manual script below, run once against a real model. |

Checkpoints 1 and 2 are pure and self-contained; they are the natural delegation boundary for
parallel subagents. Checkpoint 3 touches the composition root and must not be combined with
checkpoint 4 in one review, per migration rule 4.

## Verification

```bash
npm run typecheck
node --test tests/unit/context-transfer.test.ts
node --test tests/integration/context-transfer.test.ts
npm test
npm run check
node packages/pi-tai/skills/documentation-system/assets/check-docs.mjs
```

Live verification, from the repository root:

```bash
# 1. Bare export in a real TUI, after doing some work.
pi -e .
#    /export                        -> reports and copies "/import <ID>"
#    /export notes: parser rewrite  -> a second ID, notes reflected in the summary
#    /export ./out.html             -> upstream HTML export, unchanged
#    /export ./out.jsonl            -> upstream JSONL export, unchanged
# 2. Confirm zero pollution: /session token counts unchanged by the export,
#    and the next turn's behavior shows no awareness of the export.
# 3. In a second terminal:
pi -e .
#    /import <ID>                   -> one framed message, one restatement turn
#    /import ./out.jsonl            -> upstream session import, unchanged
# 4. Confirm on-disk shape:
ls -la "$(pi --print-agent-dir 2>/dev/null || echo ~/.pi)/pi-tai/context-exports"
```

If `pi` exposes no agent-directory flag, read the path from the export notification instead.

## Compatibility risks

| Risk | Detection | Response |
|---|---|---|
| Upstream converts `Editor.onSubmit` from a field to an accessor or caches the handler. | The alias unit test asserting the own-property accessor fails. | Fall back to overriding the submit path; the rewrite function itself is unaffected. |
| Upstream changes `getPathCommandArgument` semantics, so passthrough diverges. | The rewrite table encodes upstream's current behavior; a divergence shows up as a user-visible path being summarized instead of written. | Re-derive `firstPathArgument` from the pinned version; it is one small pure function. |
| Upstream renames or removes `/export` and `/import`, or adds a third file format. | Live verification step 1. | Add the new suffix to the path-like test; the canonical commands keep working regardless. |
| `generateSummary`'s positional signature changes. | `npm run typecheck`. | Adjust the call; it is one call site by design. |
| `sendMessage` stops entering context or stops persisting. | The integration test asserting message shape, plus a reload check in live verification. | No fallback exists that is both durable and in-context; the feature would need redesign, which is why this is the single riskiest dependency. |
| A second extension also calls `setEditorComponent` and wins. | `/export` silently stops being aliased. | The single-owner editor registrar makes Pi-Tai's own components composable; a third-party collision is out of scope for one user on one machine. |
| Users with no external editor configured now get a custom editor component. | Live verification. | The mixin adds no input handling; if a regression appears, gate the alias behind the same settings check and accept the reduced reach. |

## Out of scope

- Cross-machine and multi-user transfer. Artifacts are local files with local handles (D12).
- Selective or multi-branch export. One command exports one branch, once.
- A dedicated summarization model or effort setting. v1 uses the active session model (D12).
- Configuration surface, and therefore the matching Rust resolver, provenance descriptor, and
  differential fixture.
- Editing, listing, or deleting artifacts from inside the TUI. The directory is the interface.
- Encryption at rest. `0600` under the agent directory is the same trust boundary as session
  journals, which already contain everything a summary could.
- Guardian involvement. Export is read-only and user-initiated; import writes only to the session.

## Exit criteria

- Bare `/export` in the TUI produces an ID, copies `/import <ID>`, and writes exactly one
  summary-only artifact with mode `0600` under a `0700` directory.
- `buildSessionContext(...).messages` for the exporting session is identical before and after the
  export, asserted directly.
- `/export path.html` and `/export path.jsonl` produce upstream's files, and `/import path.jsonl`
  performs upstream's session import.
- `/import <ID>` in a fresh session injects one persistent, durable custom message framed as
  reference material and triggers exactly one turn whose response restates goal, decisions and
  rationale, state, next step, and ambiguities.
- The injected message survives a session reload and is still present in
  `buildSessionContext(...).messages`.
- Every failure in the table above produces its notification, sends no message, and leaves no
  partial file.
- `context-transfer/domain.ts` and `storage.ts` import nothing from `@earendil-works/*`.
- `npm run check` and `check-docs.mjs` pass.
