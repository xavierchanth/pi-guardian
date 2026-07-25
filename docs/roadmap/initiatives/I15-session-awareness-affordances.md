# I15 — Session presence: notifications and cmux sidebar

**Status:** Planned  
**Depends on:** I13 checkpoint 3. Start after I13 checkpoint 4.

## Outcome

A long-running session is legible from outside the pane it runs in. Notifications identify which
session fired them and what the agent actually said. Inside cmux, the sidebar carries live status,
progress, and log entries for the session, and pi-tai's own notifier stands down so the user is not
told the same thing twice.

Both surfaces are `ClientPreferences` under I13 D6 and live in the client adapter, so neither is
discarded by the ACP cutover. Under ACP the equivalent is a client-side projection of
`session/update`.

## A — Notifications that identify the session and the outcome

`notifications/register.ts` is 38 lines emitting three fixed strings with no session, project, or
outcome context (`:31` review failure, `:36` `"Ready for input."`). Concurrent sessions across
projects are indistinguishable in the notification centre.

### Scope

1. **Session identity in the title.** Prefer `pi.getSessionName()` — `session-title/register.ts:59`
   already sets it on the first meaningful turn. Fall back to `basename(ctx.cwd)` when unset. Format
   `"Pi-Tai · <identity>"`, keeping the existing string as last resort.
2. **Response opening in the body.** In the `agent_settled` handler, walk
   `ctx.sessionManager.buildContextEntries()` backwards for the last entry with `type === "message"`
   and `message.role === "assistant"`, collapse its text blocks to one truncated line, and fall back
   to `"Ready for input."` when the last assistant message is empty or tool-only.
3. **Guardian detail on review failure.** `GuardianReviewFailedEvent` carries only
   `kind: "failure" | "timeout"` (`notifications/events.ts:4`). Widen it at the emit site in
   `guardian/` to include the tool name and the review's reason; render `"<tool> — <reason>"` and
   keep today's text when the fields are absent.

### Constraints

- Keep the `try/catch` swallow at `:18-22`. Notifications must never interrupt agent work, and
  reading the transcript adds a new way to throw.
- Keep both `ctx.mode !== "tui"` guards; these are terminal notifications.
- No model call. This is formatting over state already in hand.

## B — cmux sidebar integration

### What already exists

`pi-cmux` (npm, `0.1.16`, MIT, Javi Molina) is a Pi package of cmux-powered integrations. Verified
against the published tarball:

- **Zero runtime dependencies.** One peer dependency, `@earendil-works/pi-coding-agent`, which is
  already one of pi-tai's peers — so it cannot pull a second copy of Pi into the install path, which
  I13 D11 identifies as a dual-authority failure mode.
- **Every extension is a separate module with a default export** taking `pi: ExtensionAPI`.
  `extensions/index.ts` is a 20-line bundle that calls all seven in order. There is no `exports`
  map, so deep imports of individual modules are supported.
- `extensions/cmux-sidebar.ts` (764 lines) drives status pills, progress bars, and log entries from
  Pi tool-result events, with status kinds `running | tool | waiting | complete | cancelled | error`,
  log levels, token/cost totals, and configurable thresholds.
- `extensions/cmux-notify.ts` (317 lines) raises cmux alerts when Pi waits, completes, or errors.
- `extensions/cmux-core.ts` (383 lines) is the shared transport; `extensions/i18n.ts` (123 lines)
  must be initialised before either extension runs.

cmux itself is a separate AGPL-3.0 application reached over its Unix socket (`CMUX_SOCKET_PATH`,
default `/tmp/cmux.sock`, V2 JSON-RPC) or its CLI. pi-tai never links cmux code; `pi-cmux` is MIT
and is the only thing entering the dependency graph.

### Decision — depend on `pi-cmux`, compose two of its seven extensions

Add `pi-cmux` as a normal dependency and call `initI18n(pi)`, `cmuxNotifyExtension(pi)`, and
`cmuxSidebarExtension(pi)` from pi-tai's own registrar composition. Do **not** load
`extensions/index.ts`.

The five excluded extensions are excluded for reasons, not taste:

| Excluded | Lines | Why |
|---|---|---|
| `cmux-review` | 154 | pi-tai has its own review gate (I08) — reviewer roles, findings, approval receipts. A second review flow is the dual-authority pattern migration rule 2 forbids. |
| `cmux-continue` | 451 | Overlaps workspace handoff and integration, which I06–I08 own deterministically. |
| `cmux-split`, `cmux-open`, `cmux-zoxide` | 717 | Terminal and navigation control. These are agent-driven machine capability, governed by Guardian and owned by I12 — not client chrome. |

This split is the same client/Host line drawn in I12: **reporting status into cmux is a client
concern; driving cmux surfaces is a Host capability.**

### Scope

1. Add `pi-cmux` to `dependencies`. Keep Pi packages in `peerDependencies` per I13 D11.
2. Compose the two extensions plus `initI18n` in pi-tai's registrar wiring, behind a
   `clientPreferences.cmux.enabled` gate defaulting to on. `cmux-sidebar` and `cmux-notify` already
   no-op outside cmux by checking `CMUX_WORKSPACE_ID`; the gate is for users who want them off
   inside cmux.
3. **Resolve the double-notification conflict.** With `cmux-notify` active, pi-tai's native sink
   would announce the same events. When `CMUX_WORKSPACE_ID` is set and the cmux integration is
   enabled, pi-tai's native notifier stands down and cmux owns the surface. Record this precedence
   in `SETTINGS.md`; it is the one place the two features interact.
4. Add `cmux` to `ClientPreferences` in `config/schema.ts` — unprivileged, client-local, never
   crossing the wire, per I13 D6. Pass through the `PI_CMUX_*` environment configuration rather than
   duplicating it in `pi-tai.json`.
5. Assert the boundary in `tests/repository/package-contract.test.ts`, which already asserts import
   hygiene: pi-tai imports exactly `cmux-notify`, `cmux-sidebar`, and `i18n` from `pi-cmux`, and
   never `index.ts` or the five excluded modules.

### Risks

- Deep-importing `pi-cmux/extensions/*.ts` uses a path that is public by absence of an `exports` map
  rather than by declaration. Pin the dependency to a caret range, cover the import in the package
  contract test so a breaking reorganisation fails the build rather than the user, and re-confirm on
  upgrade.
- `pi-cmux` bundles its own translations; confirm `initI18n` does not conflict with pi-tai's own
  user-facing strings.

## Exit criteria

- Two sessions in different projects produce distinguishable notifications.
- The completion notification names what the agent said.
- A review failure names the tool and the reason.
- Every notification failure path degrades to today's text rather than throwing.
- Inside cmux, the sidebar shows live pi-tai status, progress, and logs, and exactly one
  notification is raised per event.
- Outside cmux, behavior is unchanged and no cmux code path executes.
- The package contract test proves the five excluded `pi-cmux` extensions are never imported.
