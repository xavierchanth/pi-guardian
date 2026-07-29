# Pi-Tai settings

This reference documents configuration supported by the released direct Pi extension. Host-managed sessions use the same session-policy schema, but the Host resolves and pins that policy when the session is created; the runtime worker does not reread configuration files.

## Configuration sources and ownership

The direct Pi extension reads configuration at session start from:

- user: `~/.pi/agent/pi-tai.json`;
- project: `<project>/.pi/pi-tai.json`, only when Pi trusts the project.

Valid project values override user values only for fields that projects are allowed to control. Invalid values, unknown fields, and prohibited project values are ignored with a warning.

Configuration has three ownership planes:

| Plane | Fields | Authority |
|---|---|---|
| Session policy | `sessionTitle`, `compaction`, `modelProfiles` | Host-owned and pinned for Host-managed sessions |
| Client preferences | `ansiTheme`, `notifications`, `cmux` | Local to each client |
| Host machine configuration | Reserved for Guardian reviewer model and timeout | Not yet configurable |

Model-selecting fields are privileged. Project configuration cannot set any `sessionTitle` field or `modelProfiles`; those values may come only from defaults or user configuration. Project configuration may set `compaction`, `ansiTheme`, `notifications`, and `cmux` after project trust is established.

## Session policy

### `sessionTitle`

| Field | Type | Default | Description |
|---|---|---|---|
| `provider` | non-empty string | unset | Provider used only for title generation. |
| `model` | non-empty string | unset | Model used only for title generation. |
| `effort` | `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` | `minimal` | Independent title-model reasoning effort. |
| `maxWords` | integer 1–20 | `6` | Maximum normalized title length. |
| `fallback` | `heuristic` | `heuristic` | Local fallback when provider/model is absent or fails. |

Both `provider` and `model` must be present before Pi-Tai makes a title-model request. Pi-Tai never substitutes the active work model. Every field in this object is privileged and is ignored in project configuration.

### `compaction`

Pi-Tai supplements Pi's native reserve-token-based automatic compaction with a context-window percentage threshold. The check runs after Pi's native retry and compaction flow settles. When current usage is known and reaches the threshold, Pi-Tai compacts before later settled handlers run. A session that Pi already compacted reports unknown usage until its next model response, preventing duplicate compaction.

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Enable Pi-Tai's percentage-based automatic compaction. |
| `thresholdPercent` | number 1–100 | `90` | Compact when known context usage reaches or exceeds this percentage. |

Pi's native `settings.json` compaction policy remains active independently and may compact earlier when its `reserveTokens` threshold is reached. To disable all automatic compaction, disable both policies.

### `modelProfiles`

`modelProfiles` is an ordered array of named model-and-effort pairs. It controls Shift+Tab profile cycling and `/profile`; it does not change agent prompts or tool permissions. A user array replaces packaged defaults. An empty array disables profile cycling. Project values are ignored because model selection is privileged.

| Field | Type | Description |
|---|---|---|
| `name` | lowercase letters, numbers, hyphens | Stable profile name. |
| `provider` | non-empty string | Pi model provider. |
| `model` | non-empty string | Pi model ID. |
| `effort` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | Requested reasoning effort. |

Defaults are `sol-low`, `sol-medium`, and `sol-high`, in that cycling order; `sol-low` is the first/default profile. Pi-Tai reserves Shift+Tab for profile cycling and moves Pi's native thinking-level cycle to Ctrl+Alt+T. On load, it merges the native mapping into `~/.pi/agent/keybindings.json`, preserving unrelated bindings and additional keys assigned to thinking-level cycling. Invalid JSON is never overwritten and produces a warning. Use `/effort` to change effort independently and Pi's `/model` for unrestricted model selection.

## Client preferences

### `ansiTheme`

| Field | Type | Default | Description |
|---|---|---|---|
| `darkTheme` | non-empty string | `ansi-dark` | Theme selected for a dark terminal background. |
| `lightTheme` | non-empty string | `ansi-light` | Theme selected for a light terminal background. |
| `pollIntervalMs` | integer 250–60000 | `2000` | Delay between completed OSC 11 queries. |

ANSI background queries are owned by the active interactive TUI; periodic polling continues only after the terminal confirms support with a valid response.

### `notifications`

| Field | Type | Default | Description |
|---|---|---|---|
| `reviewFailure` | boolean | `true` | Native terminal notification when automatic review fails or times out. |
| `agentCompletion` | boolean | `true` | Native terminal notification when the agent settles ready for input. |

Notifications run only in interactive TUI mode and use Kitty OSC 99 when available, otherwise OSC 777.

### `cmux`

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Enable cmux sidebar status and cmux notifications when `CMUX_WORKSPACE_ID` is present. |

Activation requires all three conditions:

1. the session runs inside cmux and has a non-empty `CMUX_WORKSPACE_ID`;
2. the `cmux` executable is available on `PATH`;
3. `cmux.enabled` resolves to `true`.

When active, Pi-Tai composes only `pi-cmux`'s sidebar and notification modules. Those modules present live status, progress, token totals, logs, and completion alerts. Native completion notifications stand down to prevent duplicates, while Guardian review-failure notifications remain on Pi-Tai's safety channel.

When any activation condition is false, no cmux module is initialized and native completion notifications remain active. Changing `cmux.enabled` during configuration reload dynamically stops or restores cmux event delivery without registering duplicate handlers.

Advanced behavior is configured with upstream environment variables rather than duplicated in `pi-tai.json`:

| Variable | Upstream default | Purpose |
|---|---:|---|
| `PI_CMUX_NOTIFY_LEVEL` | `all` | Notification level: `all`, `medium`, `low`, or `disabled`. |
| `PI_CMUX_NOTIFY_INCLUDE_RESPONSE` | `0` | Include a truncated final assistant response in non-error alerts. |
| `PI_CMUX_NOTIFY_THRESHOLD_MS` | `15000` | Duration threshold used to distinguish completion from waiting. |
| `PI_CMUX_SIDEBAR` | `1` | Set to `0` to disable sidebar reporting. |
| `PI_CMUX_SIDEBAR_FLASH` | `all` | Surface flashing: `all`, `error`, or `disabled`. |
| `PI_CMUX_SIDEBAR_PROGRESS` | `1` | Set to `0` to disable progress updates. |
| `PI_CMUX_SIDEBAR_TOKENS` | `1` | Include cumulative token totals. |
| `PI_CMUX_SIDEBAR_COST` | `0` | Include reported model cost. |
| `PI_CMUX_SIDEBAR_LOG_TOOLS` | `0` | Set to `1` to log every tool result. |

Pi-Tai passes these variables through unchanged. Other `pi-cmux` settings and commands are not part of Pi-Tai's reporting-only integration.

If cmux presentation does not appear, verify `command -v cmux`, `CMUX_WORKSPACE_ID`, and the resolved `cmux.enabled` value. A missing CLI intentionally falls back to native notifications rather than suppressing all alerts.

## Example

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
  },
  "notifications": {
    "reviewFailure": true,
    "agentCompletion": true
  },
  "cmux": {
    "enabled": true
  },
  "compaction": {
    "enabled": true,
    "thresholdPercent": 90
  },
  "modelProfiles": [
    { "name": "sol-low", "provider": "openai-codex", "model": "gpt-5.6-sol", "effort": "low" },
    { "name": "sol-medium", "provider": "openai-codex", "model": "gpt-5.6-sol", "effort": "medium" },
    { "name": "sol-high", "provider": "openai-codex", "model": "gpt-5.6-sol", "effort": "high" }
  ]
}
```

## Action Guardian

Guardian currently has no settings. It reviews every agent-generated `bash` call with `openai-codex/codex-auto-review` through Pi's existing Codex OAuth authentication, with a 30-second deadline.

Low- and medium-risk related work may proceed. High- and critical-risk actions never execute through an agent: related actions are returned to the root user for direct human execution, while unrelated or unclear actions are denied without a runnable command. Destructive candidates fail closed when review is unavailable; ordinary actions proceed. Guardian never provides an interactive approval or persistent bypass path.

Built-in file tools enforce canonical workspace boundaries. External research is delegated through the `researcher` subagent capability; root sessions have no direct web tools.

## Context transfer

Context transfer v1 has no configuration. Use `/context-export [notes…]` and `/context-import <ID>`; artifacts are retained locally for 30 days, with at most 50 kept.
