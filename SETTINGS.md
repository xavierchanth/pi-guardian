# Pi-Tai settings

## Pi-Tai configuration

Pi-Tai reads:

- global: `~/.pi/agent/pi-tai.json`
- project: `<project>/.pi/pi-tai.json`

Project configuration is read only after Pi trusts the project. Valid project fields override global fields; invalid values are ignored with a warning.

### `sessionTitle`

| Field | Type | Default | Description |
|---|---|---|---|
| `provider` | non-empty string | unset | Provider used only for title generation. |
| `model` | non-empty string | unset | Model used only for title generation. |
| `effort` | `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` | `minimal` | Independent title-model reasoning effort. |
| `maxWords` | integer 1–20 | `6` | Maximum normalized title length. |
| `fallback` | `heuristic` | `heuristic` | Local fallback when provider/model is absent or fails. |

Both `provider` and `model` must be present before Pi-Tai makes a title-model request. Pi-Tai never substitutes the active work model.

### `ansiTheme`

| Field | Type | Default | Description |
|---|---|---|---|
| `darkTheme` | non-empty string | `ansi-dark` | Theme selected for a dark terminal background. |
| `lightTheme` | non-empty string | `ansi-light` | Theme selected for a light terminal background. |
| `pollIntervalMs` | integer 250–60000 | `2000` | Delay between completed OSC 11 queries. |

ANSI querying runs only in interactive TUI mode.

### `notifications`

| Field | Type | Default | Description |
|---|---|---|---|
| `reviewFailure` | boolean | `true` | Native terminal notification when automatic review fails or times out. |
| `agentCompletion` | boolean | `true` | Native terminal notification when the agent settles ready for input. |

Notifications run only in interactive TUI mode and use Kitty OSC 99 when available, otherwise OSC 777.

### `modelProfiles`

`modelProfiles` is an ordered array of named model-and-effort pairs. It controls Shift+Tab profile cycling and `/profile`; it does not change agent prompts or tool permissions. A global array replaces packaged defaults, and a trusted project array replaces the global array. An empty array disables profile cycling.

| Field | Type | Description |
|---|---|---|
| `name` | lowercase letters, numbers, hyphens | Stable profile name. |
| `provider` | non-empty string | Pi model provider. |
| `model` | non-empty string | Pi model ID. |
| `effort` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | Requested reasoning effort. |

Defaults are `sol-high`, `sol-low`, and `luna-high`. Use `/effort` to change effort independently and Pi's `/model` for unrestricted model selection.

### Example

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
  "modelProfiles": [
    { "name": "sol-high", "provider": "openai-codex", "model": "gpt-5.6-sol", "effort": "high" },
    { "name": "sol-low", "provider": "openai-codex", "model": "gpt-5.6-sol", "effort": "low" },
    { "name": "luna-high", "provider": "openai-codex", "model": "gpt-5.6-luna", "effort": "high" }
  ]
}
```

## Action Guardian

The action guardian has no settings. It reviews every agent-generated `bash` call with `openai-codex/codex-auto-review` through Pi's existing Codex OAuth authentication, with a 30-second review deadline. Built-in file tools are restricted to canonical workspace and OS temporary roots, except that read-only tools may inspect Pi's resource/package directories and standard global `.agents/skills`. Writes retain the stricter workspace/temp boundary. Interactive approval after a denied or failed review applies once to the exact current invocation; noninteractive modes fail closed.

## Native Pi settings

Pi-Tai does not own native settings such as `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `enabledModels`, `theme`, or `packages`. Configure those through Pi normally.
