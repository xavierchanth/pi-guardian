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
  }
}
```

## Action Guardian

The action guardian has no settings. It reviews every agent-generated `bash` call with `openai-codex/codex-auto-review` through Pi's existing Codex OAuth authentication, with a 30-second review deadline. Built-in file tools are restricted to canonical workspace and OS temporary roots. Interactive approval after a denied or failed review applies once to the exact current invocation; noninteractive modes fail closed.

## Native Pi settings

Pi-Tai does not own native settings such as `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `enabledModels`, `theme`, or `packages`. Configure those through Pi normally.
