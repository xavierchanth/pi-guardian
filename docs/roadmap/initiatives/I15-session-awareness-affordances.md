# I15 — Session presence: notifications and cmux sidebar

**Status:** In progress  
**Depends on:** I13 checkpoint 3. Started after I13 checkpoint 4.

## Outcome

A long-running CLI session is legible from outside its pane. Notifications identify the session and
summarize the agent outcome. Inside cmux, the sidebar carries live status, progress, token totals,
and log entries, while native completion notifications stand down so one event produces one alert.

These surfaces are `ClientPreferences` under I13 D6 and remain in the client adapter. Under ACP,
the equivalent is a client-side projection of `session/update`.

## Delivered implementation

### Contextual notifications

The direct Pi client now:

- titles notifications from `pi.getSessionName()`, falling back to the project-directory name;
- extracts the latest assistant text from session context, collapses it to one line, and bounds it;
- falls back to `"Ready for input."` for empty, tool-only, or unreadable context;
- includes the tool name and reviewer reason in Guardian failure notifications when available;
- catches notification and transcript-projection failures so presentation cannot interrupt work.

### Reporting-only cmux composition

Pi-Tai depends on `pi-cmux` `^0.1.16` and dynamically composes exactly three deep modules when
`CMUX_WORKSPACE_ID` is present and the `cmux` executable is available on `PATH`:

- `extensions/i18n.ts`;
- `extensions/cmux-notify.ts`;
- `extensions/cmux-sidebar.ts`.

The dependency is not initialized outside cmux or when its CLI is unavailable. A dynamic
`clientPreferences.cmux.enabled` gate, defaulting to `true`, wraps every registered cmux event
handler. This allows configuration reloads to disable or re-enable event delivery without
installing a second set of handlers.

The five control-oriented modules remain excluded:

| Excluded | Boundary |
|---|---|
| `cmux-review` | Pi-Tai's reviewer roles, findings, and approval receipts own review. |
| `cmux-continue` | Pi-Tai's deterministic workspace handoff and integration own continuation. |
| `cmux-split`, `cmux-open`, `cmux-zoxide` | Agent-driven terminal control is an I12 machine capability governed by Guardian. |

Reporting status into cmux is client presentation. Driving cmux surfaces is machine authority.

### Notification precedence

When cmux is present, its executable is available, and the integration is enabled, `pi-cmux` owns
agent completion alerts and Pi-Tai suppresses its native completion notification. Guardian
review-failure notifications remain on Pi-Tai's safety channel because `pi-cmux` does not consume
the custom Guardian event. When cmux is absent, unavailable, or disabled, native behavior remains
active.

`PI_CMUX_*` environment variables pass through unchanged. Pi-Tai does not mirror upstream sidebar,
threshold, flash, token, cost, or logging controls into `pi-tai.json`.

## Configuration ownership

`clientPreferences.cmux.enabled` is client-local, unprivileged, and accepted from user or trusted
project configuration. TypeScript and Rust resolvers share the field, provenance descriptor, and
differential fixture. Host/runtime policy transport remains unchanged because client preferences do
not cross that boundary.

## Package boundary

The package contract test pins the deep-import surface and rejects imports of `extensions/index.ts`
or any excluded module. `pi-cmux` publishes TypeScript source, so Pi-Tai loads those modules through
a pinned `jiti` runtime only when cmux is present; filesystem transpilation caches are disabled.
Ordinary Node tests and non-cmux processes never attempt to type-strip TypeScript under
`node_modules`. The isolated Pi smoke test exercises the real package loader with cmux environment
present.

## Remaining acceptance

Run one interactive session in a real cmux workspace. Before testing, confirm that
`command -v cmux` succeeds and `CMUX_WORKSPACE_ID` is non-empty. Then confirm that:

1. status, progress, token totals, and final logs appear in the intended sidebar surface;
2. a completed run raises exactly one cmux alert;
3. `cmux.enabled: false` suppresses sidebar and cmux alerts while restoring native completion;
4. upstream `PI_CMUX_*` overrides behave as documented by `pi-cmux`.

No code change is expected unless live cmux behavior contradicts the packaged integration.

## Exit criteria

- Two sessions in different projects produce distinguishable notifications.
- Completion notifications name what the agent said.
- Guardian review failures name the tool and reason.
- Notification formatting failures degrade to stable fallback text without throwing.
- Inside cmux, the sidebar shows live status, progress, tokens, and logs with one completion alert.
- Outside cmux, behavior is unchanged and `pi-cmux` is not initialized.
- The package contract proves that control-oriented `pi-cmux` extensions are never imported.
