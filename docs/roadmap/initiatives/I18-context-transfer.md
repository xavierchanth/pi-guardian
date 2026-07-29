# I18 — Context transfer with `/context-export` and `/context-import`

**Status:** Planned  
**Depends on:** I00. Uses no I13 checkpoint beyond what already ships.

## Outcome

A user types `/context-export [notes…]`, receives a short ID, and pastes
`/context-import <ID>` into a fresh session on the same machine. The new session receives the goal,
settled decisions and rationale, current state, next step, and remaining ambiguity.

These are the only commands added by Pi-Tai. Upstream Pi's `/export` and `/import` remain untouched
built-ins for file and session transfer; Pi-Tai does not override, alias, rewrite, or otherwise
intercept them.

Export is out-of-band: it summarizes the current branch through the public `generateSummary` entry
point and writes nothing into the session. Import is deliberate and in-band: it injects one
persistent custom message framed as reference material and triggers a model turn asking for a
concise restatement.

## Product framing

This is a terminal-client affordance in the same family as I15 and I16. It spends tokens only on
explicit invocation and takes no machine authority. Unlike I16, import deliberately leaves a
durable trace that survives reload.

The artifact store is machine-scoped. Nothing leaves the machine: the artifact is a local file and
the ID is a local handle, not a URL.

## Settled decisions

| ID | Decision | Rationale |
|---|---|---|
| D1 | Pi-Tai registers only `context-export` and `context-import`. | Distinct names are explicit and leave upstream `/export` and `/import` unchanged. |
| D2 | Export uses public `generateSummary` on the current branch, out-of-band, with no session fork or model-visible entry. | Quality follows upstream compaction while the source session remains unchanged. |
| D3 | Artifacts are summary-only and versioned. | No raw transcript, tool output, or message array; files stay small and reviewable. |
| D4 | IDs are 8 Crockford-base32 characters and are validated before filesystem access. | They are short to retype and make path-traversal rejection total. |
| D5 | Storage is `getAgentDir()/pi-tai/context-exports`, with `0700` directories, `0600` files, and atomic writes. | This follows existing Pi-Tai storage conventions. |
| D6 | Successful export reports and copies `/context-import <ID>`. | The next action is a paste into another session. |
| D7 | Import injects a persistent custom message and triggers one turn that only restates transferred context. | This is durable, enters context, and gives the user a correction point before work starts. |
| D8 | v1 is single-user, single-machine, uses the active model, applies automatic retention, and adds no configuration. | Keep the first release bounded and avoid premature policy surface. |

## Command contract

| Command | Argument | Behavior |
|---|---|---|
| `/context-export [notes…]` | Optional free-text notes | Summarize the current branch, write an artifact, and copy `/context-import <ID>`. |
| `/context-import <ID>` | One required local artifact ID | Load the artifact, inject it as reference material, and trigger a restatement turn. |

Both commands use `ExtensionAPI.registerCommand` and work anywhere extension commands are
supported. There is no TUI editor hook, command alias, or path disambiguation. Upstream `/export`
and `/import` retain their built-in semantics.

## Grounded API surface

Implementation must re-verify these mechanisms against the repository's pinned
`@earendil-works/pi-coding-agent` version.

| Need | Mechanism |
|---|---|
| Commands | `ExtensionAPI.registerCommand(name, { description, handler })` |
| Current branch | `buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId())` |
| Summarization | `generateSummary` with `DEFAULT_COMPACTION_SETTINGS.reserveTokens` |
| Model/auth | `ctx.model`, `ctx.modelRegistry.getApiKeyAndHeaders(model)`, `pi.getThinkingLevel()` |
| Durable import | `pi.sendMessage(customMessage, { triggerTurn: true })` |
| Import rendering | `pi.registerMessageRenderer(customType, renderer)` |
| Clipboard and storage root | Package-root exports `copyToClipboard` and `getAgentDir` |

## Storage

Root: `join(getAgentDir(), "pi-tai", "context-exports")`. File: `<ID>.json`, first written to a
same-directory temporary file and atomically renamed.

```jsonc
{
  "version": 1,
  "id": "A1B2C3D4",
  "createdAt": "2026-07-29T12:34:56.789Z",
  "summary": "…",
  "notes": "optional verbatim notes",
  "source": {
    "cwd": "/abs/path/to/project",
    "sessionId": "…",
    "model": { "provider": "anthropic", "id": "claude-…" },
    "piTaiVersion": "0.1.0"
  }
}
```

The record has no field for messages, entries, tool results, or file contents. The record ID must
match the filename. Unknown versions and malformed records are rejected. `artifactPath` validates
`/^[0-9A-HJKMNP-TV-Z]{8}$/` and confirms the resolved parent is the artifact root.

IDs come from 40 random bits encoded as 8 Crockford-base32 characters. Generation retries at most
five collisions and never overwrites. Input normalization uppercases, removes whitespace and `-`,
folds `I`/`L` to `1` and `O` to `0`, then validates; `U` is rejected.

After successful export, best-effort pruning keeps artifacts no older than 30 days and at most the
50 newest. A prune failure warns but does not fail export.

## Flows

### Export

1. Snapshot entries and leaf ID, then build the branch context. Empty context stops with an info
   notification.
2. Resolve the active model and credentials; stop with an error notification if unavailable.
3. Ask `generateSummary` for goal, decisions and rationale, state, next step, and ambiguity, adding
   optional command notes as focus.
4. Use a private abort controller and a 120-second timeout. Reject an empty summary.
5. Write one artifact atomically, prune, report `/context-import <ID>`, and copy that command.
6. Clear progress status in `finally`. Clipboard or prune failures warn after a successful export.

The export path only reads session state. It does not call session mutation APIs, compact, fork, or
create a session.

### Import

1. Normalize and validate the complete command argument as an ID.
2. Read and validate the artifact, distinguishing missing, corrupt, ID-mismatched, and unsupported
   versions.
3. Send one displayed `pi-tai:context-import` custom message with `triggerTurn: true`.
4. Frame the summary as reference material from a previous session, not a request to act. Ask the
   model to restate goal, decisions and rationale, state, next step, and ambiguity, then stop.
5. Render a compact header and excerpt. Re-import and import into a non-empty session are allowed.

## Files and responsibilities

Add `packages/pi-tai/src/context-transfer/`:

| File | Responsibility |
|---|---|
| `domain.ts` | IDs, artifact parsing/serialization, summary instructions, import framing; no Pi imports |
| `storage.ts` | Paths, atomic read/write, modes, listing, and pruning; no Pi imports |
| `summarize.ts` | Branch-context, auth, timeout, and `generateSummary` adapter |
| `export.ts` | Export orchestration, notifications, clipboard, and pruning |
| `import.ts` | ID validation, artifact read, and `sendMessage` |
| `render.ts` | `pi-tai:context-import` message renderer |
| `register.ts` | Register the two context commands and renderer |
| `index.ts` | Barrel exports |

Change only the composition root needed to add a `contextTransfer` registrar. No editor component,
response-editor registrar, or upstream command handling changes are part of I18. Dependencies such
as agent directory, summarizer, clock, ID factory, and clipboard remain injectable for tests.

## Failure behavior

All failures notify rather than throwing into a turn, and failed writes leave no partial artifact.

| Condition | Behavior |
|---|---|
| No context, model, or credentials | Notify; write nothing |
| Summary error, empty result, or timeout | Error; write nothing |
| Write failure | Remove temporary file and report an error |
| Clipboard or prune failure | Warn; export remains successful and the ID is shown |
| Five ID collisions | Error; never overwrite |
| Missing or malformed import ID | Show `/context-import <ID>` usage or an invalid-ID error |
| Unknown ID | Report no context export with that ID |
| Corrupt, ID-mismatched, or unsupported artifact | Report the specific validation failure; send no message |

## Tests

- Unit: ID generation and normalization; artifact round-trip/version/path closure; summary and
  import framing; storage modes, atomicity, and retention.
- Integration: `/context-export` writes one artifact, copies `/context-import <ID>`, and performs no
  session mutation; `/context-import <ID>` sends exactly one durable, displayed, triggered custom
  message; failures send nothing; two fake hosts round-trip a summary.
- Composition: registrar list and order include `contextTransfer` without editor registrar changes.
- Package contract: `domain.ts` and `storage.ts` import nothing from `@earendil-works/*`.

No tests for bare command rewriting, path detection, editor submission, or upstream built-in
overrides belong to this initiative.

## Documentation

At implementation, document the two context-prefixed commands and local artifact location in the
root README. State in SETTINGS that v1 has no configuration. Upstream `/export` and `/import` may be
mentioned only to clarify that they remain untouched built-ins.

## Sequencing

| # | Checkpoint | Exit |
|---|---|---|
| 1 | Domain and storage modules with unit tests | IDs, schema, path closure, atomic writes, modes, and retention pass; no Pi imports |
| 2 | Summarize, export, import, rendering, and registration | Integration tests pass with injected dependencies |
| 3 | Composition root and documentation | Registrar contract, documentation check, and full checks pass |
| 4 | Live verification | Real-model export/import succeeds and reload preserves the imported message |

Checkpoint 1 can be delegated independently. Checkpoint 2 depends on its contracts; checkpoint 3
depends on registration; checkpoint 4 follows automated verification.

## Verification

```bash
npm run typecheck
node --test tests/unit/context-transfer.test.ts
node --test tests/integration/context-transfer.test.ts
npm test
npm run check
node packages/pi-tai/skills/documentation-system/assets/check-docs.mjs
```

Live verification:

1. In a session with useful context, run `/context-export notes about the current focus` and record
   the copied `/context-import <ID>` command.
2. Confirm the source session has no new model-visible entry.
3. In a fresh session, run the copied command and confirm one restatement turn.
4. Reload and confirm the imported message remains in context.
5. Optionally confirm upstream `/export` and `/import` still behave exactly as provided by Pi.

## Risks

| Risk | Detection | Response |
|---|---|---|
| `generateSummary` signature changes | Typecheck | Update the single adapter call |
| `sendMessage` ceases to persist or enter context | Integration plus live reload check | Redesign; there is no fallback that is both durable and in-context |
| Artifact permissions or atomicity regress | Storage tests | Fail export before exposing a partial artifact |
| IDs collide or malformed input escapes the root | Collision and path-closure tests | Retry boundedly; reject before filesystem access |

## Out of scope

- Aliases for `/export` or `/import`, editor `onSubmit` hooks, editor registrar refactors, and path
  disambiguation.
- Any override or modification of upstream Pi built-ins.
- Cross-machine or multi-user transfer; selective or multi-branch export.
- Dedicated model/effort settings or other configuration.
- Artifact editing, listing, or deletion commands; encryption at rest; Guardian involvement.

## Exit criteria

- `/context-export [notes…]` writes exactly one summary-only `0600` artifact beneath a `0700`
  directory, reports an ID, and copies `/context-import <ID>`.
- Export leaves the source session's model-visible context unchanged.
- `/context-import <ID>` injects one persistent framed message and triggers exactly one restatement
  turn; the message survives reload.
- Upstream `/export` and `/import` remain untouched built-ins.
- Error cases send no import message and leave no partial artifact.
- Domain and storage modules have no `@earendil-works/*` imports.
- `npm run check` and the documentation check pass.
