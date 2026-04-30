# pi-tai

`pi-tai` is a [Pi](https://pi.dev) distribution that bundles a small set of focused extensions.

## Installation

```sh
pi install https://github.com/xavierchanth/pi-guardian
```

## Included plugins

### 1. Task Context
Source:
- `extensions/task-context/index.ts`

What it does:
- tracks a current goal and task list
- shows lightweight task status in the UI
- persists task state in the session
- supports the `task-context` block workflow

### 2. Modes
Source:
- `extensions/modes/index.ts`

What it does:
- provides mode-based access control for the agent
- adds direct mode commands
- supports a review mode for confirmation behavior

Available modes:
- `auto`
- `plan`
- `edit`
- `read`

Commands:
- `/mode`
- `/mode:auto`
- `/mode:plan`
- `/mode:edit`
- `/mode:read`
- `/review-mode`

#### Auto mode
Auto mode is the most capable mode in the distribution.

Behavior:
- allows read and write tools
- allows the broadest bash access
- uses guardian auto-review for higher-risk actions
- is the mode required for sensitive or out-of-scope file access

#### Plan mode
Plan mode is meant for planning rather than implementation.

Behavior:
- adds a brief planning-oriented system prompt
- allows read access and read-level bash usage
- allows Markdown-only file changes: `.md`, `.mdx`
- blocks non-Markdown implementation edits unless you switch modes

#### Edit mode
Edit mode is for normal in-workspace file editing without full auto mode.

Behavior:
- allows read access
- allows file edits in ordinary project files
- blocks sensitive or out-of-scope file changes unless you move to `auto`
- allows more than `read`, but less than `auto`

#### Read mode
Read mode is the most restrictive mode.

Behavior:
- allows read access to ordinary workspace files
- allows read-level bash usage
- blocks file modifications
- blocks sensitive or out-of-scope file access unless you move to `auto`

### 3. Ghostty Theme Sync
Bundled dependency:
- `@ogulcancelik/pi-ghostty-theme-sync`

What it does:
- syncs Pi theme colors with the active Ghostty terminal theme

## Extension layout

```text
extensions/
├─ task-context/
│  └─ index.ts
└─ modes/
   ├─ core/
   ├─ definitions/
   └─ index.ts
```

## Testing

Per `AGENTS.md`, test with only this distribution loaded using:

```sh
pi -ne -e . "<your-prompt>"
```

## Attributions

- Modes extension attribution and license notes: `extensions/modes/LICENSE.md`
- Ghostty theme sync: `@ogulcancelik/pi-ghostty-theme-sync`
