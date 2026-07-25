# I16 — `/btw`, a sidebar query against session context

**Status:** Planned  
**Depends on:** I13 checkpoint 3

## Outcome

`/btw <question>` answers with **full context of the current session**, and neither the question nor
the answer enters session history or the context window. It is a sidebar: read the context, answer,
leave no trace in what the agent subsequently sees.

## Why this is directly supported

Pi's extension API supplies every piece, verified against `@earendil-works/pi-coding-agent`:

| Need | Mechanism |
|---|---|
| Register the command | `ExtensionAPI.registerCommand(name, {description, handler})`; the handler receives `ExtensionCommandContext`. Six commands already register this way. |
| Read exactly what the agent sees | `buildSessionContext(entries, leafId)`, exported from the package root, returning `{ messages: AgentMessage[] }`. Call it as the free function over `ctx.sessionManager.getEntries()` and `getLeafId()`; the method form is not on `ReadonlySessionManager`'s `Pick` list, the free function is the supported route. Compaction- and branch-aware. |
| One-off model call | `completeSimple` from `@earendil-works/pi-ai/compat`, exactly as `session-title/generate.ts:31` does it, including the `ctx.modelRegistry.find` → `getApiKeyAndHeaders` handshake. |
| Show it without polluting context | `pi.appendEntry(customType, data)` — "not sent to LLM" — plus `pi.registerEntryRenderer(customType, renderer)` — "Custom entries do not participate in LLM context". |

`appendEntry` + `registerEntryRenderer` is what makes the requirement achievable rather than
approximated: the exchange is visible in the transcript and survives reload, while
`buildSessionContext` skips it because it is a `CustomEntry`, not a `SessionMessageEntry`.

## Scope

New module `packages/pi-tai/src/sidebar/` — `domain.ts` (pure), `ask.ts` (the model call),
`render.ts` (the entry renderer), `register.ts` (the thin Pi adapter), matching `session-title/` and
`web/`. Do **not** add this to `subagents/register.ts`, which is scheduled for dismantling in I01.

1. `registerCommand("btw", …)`. Reject an empty argument through `ctx.ui`. A sidebar query is safe
   while the agent streams, so do not block on `ctx.isIdle()`, but snapshot the entries once up
   front so a concurrent turn cannot shift the context mid-call.
2. Build the query from `buildSessionContext(...)` plus a system prompt stating that the model is
   answering a side question about an in-progress coding session, has no tools, and that its answer
   is shown to the user only and will not be seen by the agent. Append the question as the final
   user message.
3. Bound the input against the sidebar model's `contextWindow` from the registry rather than a magic
   constant; prepend a truncation marker when trimming.
4. Call the model with an `AbortController`, `maxRetries: 0`, and no tools. Surface a timeout as an
   entry, not a throw.
5. `pi.appendEntry("pi-tai:btw", {question, answer, model, at})` with a renderer for both the answer
   and the error case, so a failed query is legible rather than silent.
6. Add a `sidebar` block to `SessionPolicy` — `{provider, model, effort}` — defaulting to the current
   session model via `ctx.model`. **Unprivileged** under I13 D6: unlike `sessionTitle` it is
   user-invoked per call, so a project-supplied value cannot cause unattended token spend.

## Out of scope

- No tools. A sidebar that can act is not a sidebar.
- No Guardian involvement — user-initiated, read-only, no side effects.
- No steering. `/btw` never calls `sendUserMessage` or `sendMessage`; if the user wants the answer in
  context, they paste it.

## Migration constraint

Keep `sidebar/domain.ts` and `sidebar/ask.ts` free of Pi imports so only `register.ts` and
`render.ts` are Pi-specific, per I01's core/adapter split. Under ACP the equivalent is an
available-command plus a client-rendered result, which is the same split.

## Exit criteria

- `/btw <q>` answers using session context and renders in the transcript.
- The following turn's provider request contains no trace of the question or the answer, asserted
  directly by inspecting `buildSessionContext(...).messages` after the entry is appended.
- The entry survives a session reload and still does not enter context.
- A failed or timed-out query leaves a legible entry and does not disturb a running turn.
