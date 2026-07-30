# I16 — `/btw`, a one-shot query against session context

**Status:** Complete  
**Depends on:** —

## Outcome

`/btw <question>` takes an exact synchronous snapshot of session entries and leaf, builds Pi's
branch- and compaction-aware context, and makes one tool-free completion with the current session
model and effort. The exchange is persisted and rendered, but neither question nor answer enters
later model context.

Bare `/btw` opens the standard TUI input dialog titled **by the way**, with placeholder **Ask a
one-off question…**. This lifecycle/UX follows the sidebar-query pattern without creating a child
agent: `/btw` is not a subagent and has no tools.

## Delivered design

Pure bounding/result logic lives in `sidebar/domain.ts`; the one-shot AI call lives in `ask.ts`;
Pi registration and rendering remain in `register.ts` and `render.ts`.

- The exact active provider/model is resolved through the model registry and its auth handshake.
  Missing model or auth is a persisted error; there is no fallback.
- Effort inherits `ctx.getThinkingLevel()`. There is no `SessionPolicy` sidebar configuration.
- Calls use `maxRetries: 0`, a 45-second abort timeout, no tools, and at most two synchronously
  reserved calls per session.
- Input is bounded from the selected model's context window. Oldest coherent groups are removed;
  assistant tool calls remain with following tool results, and an explicit omission marker is added.
  Output is bounded by model limits and records truncation.
- Every post-question-validation result is a typed `pi-tai:btw` custom entry containing success or
  error state, question, answer/error, model, timestamp, and input/output truncation metadata.
  Custom entries are excluded by `buildSessionContext`, including after reload and branching.
- Compact rendering shows a bounded preview; expanded rendering shows metadata, question, and
  Markdown answer/error. Session shutdown aborts outstanding calls.

## Boundaries

No Guardian behavior changes. `/btw` does not call `sendMessage` or `sendUserMessage`, cannot steer
the main agent, receives no tools, and does not use child-agent architecture.

## Acceptance

Tests cover coherent context trimming, output bounds, composition registration, and direct context
exclusion after append, persisted reload, and branch navigation.
