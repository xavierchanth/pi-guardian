# Settings Reference

This document lists every configuration value that the `pi-tai` distribution reads from or writes to `~/.pi/agent/settings.json`.

---

## Settings written by this distribution

### `permissionLevel`

**Type:** `string`  
**Values:** `"auto"` | `"plan"` | `"edit"` | `"read"`

The active guardian mode. Persisted when you run `/mode` and choose **"Save globally"**.

- `auto` — Full access with auto-review for dangerous/high-risk actions
- `plan` — Planning-only; Markdown-only file edits; read-level bash
- `edit` — Read and edit files; no dangerous bash
- `read` — Read-only access

**Example:**
```json
{
  "permissionLevel": "auto"
}
```

---

### `permissionMode`

**Type:** `string`  
**Values:** `"ask"` | `"block"`

The review behavior when an action exceeds the current mode's permissions.

- `ask` — Prompt to upgrade to a higher mode (default)
- `block` — Reject the action outright

Persisted when you run `/review-mode`.

**Example:**
```json
{
  "permissionMode": "ask"
}
```

---

### `permissionConfig`

**Type:** `object`  
**Optional**

Fine-grained command classification overrides and prefix normalisation.

| Field | Type | Description |
|-------|------|-------------|
| `overrides` | `Record<string, string[]>` | Force specific permission levels for command patterns. Keys: `read`, `edit`, `auto`, `dangerous`. |
| `prefixMappings` | `{ from: string, to: string }[]` | Strip/replace command prefixes before classification. |

**Example:**
```json
{
  "permissionConfig": {
    "overrides": {
      "read": ["tmux list-*", "tmux show-*"],
      "auto": ["tmux *", "screen *"],
      "dangerous": ["rm -rf *", "dd if=* of=/dev/*"]
    },
    "prefixMappings": [
      { "from": "fvm flutter", "to": "flutter" },
      { "from": "nvm exec", "to": "" }
    ]
  }
}
```

Access via `/mode config show` and `/mode config reset`.

---

## Settings read by this distribution

### `autoReviewModels`

**Type:** `string[]`  
**Optional**

List of `"provider/model"` identifiers that trigger the guardian auto-review agent when running in non-interactive mode (`pi -p`, `pi -ne`, etc.).

Each entry must contain a `/` separator.

**Example:**
```json
{
  "autoReviewModels": [
    "openai-codex/gpt-5.4-mini",
    "opencode-go/qwen3.5-plus"
  ]
}
```

If omitted or empty, auto-review is unavailable in non-interactive mode and dangerous actions are denied outright.

---

### `quietStartup`

**Type:** `boolean`  
**Optional**

If `true`, the modes extension suppresses the startup permission banner and sound notification.

**Example:**
```json
{
  "quietStartup": true
}
```

> **Note:** This setting is not owned by `pi-tai`; it is a native Pi setting that this distribution respects.

---

## Settings **not** touched by this distribution

The following Pi-native settings are **unaffected** by `pi-tai`. They are listed here only to clarify scope.

| Setting | Description |
|---------|-------------|
| `theme` | Managed dynamically by the ANSI Theme extension (no manual setting required). |
| `defaultProvider` | Native Pi setting for the default LLM provider. |
| `defaultModel` | Native Pi setting for the default model. |
| `defaultThinkingLevel` | Native Pi setting for the default thinking level. |
| `hideThinkingBlock` | Native Pi setting to hide the thinking block. |
| `enabledModels` | Native Pi setting for the model picker whitelist. |
| `packages` | Native Pi setting for installed distributions; should include this repo's URL. |

---

## Package-level configuration

These values live in this repo's `package.json`, not in `~/.pi/agent/settings.json`.

### `pi.extensions`

**Type:** `string[]`

Paths to the TypeScript entry points for each bundled extension.

```json
{
  "pi": {
    "extensions": [
      "./extensions/task-context/index.ts",
      "./extensions/modes/index.ts",
      "./extensions/ansi-theme/index.ts"
    ]
  }
}
```

---

## Full example `settings.json`

```json
{
  "lastChangelogVersion": "0.70.6",
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-6",
  "defaultThinkingLevel": "medium",
  "hideThinkingBlock": false,
  "enabledModels": [
    "gpt-5.4",
    "claude-sonnet-4-6",
    "kimi-k2.6"
  ],
  "permissionLevel": "auto",
  "permissionMode": "ask",
  "permissionConfig": {
    "overrides": {
      "read": ["tmux list-*"]
    }
  },
  "autoReviewModels": [
    "openai-codex/gpt-5.4-mini",
    "opencode-go/qwen3.5-plus"
  ],
  "quietStartup": true,
  "packages": [
    "https://github.com/xavierchanth/pi-guardian"
  ]
}
```
