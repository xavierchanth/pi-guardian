# pi-tai

This is a distribution for [pi the coding agent](https://pi.dev).  

## Included extensions

## Installation

```sh
pi install https://github.com/xavierchanth/pi-guardian
```

Please open an issue if you'd like me to publish to npm.
If there are enough upvotes I will do it.

## Usage

There are two commands:

- /permissions - allows you to pick between read, edit, auto.
  - read allows read only access to the workspace, with certain secret files ignored.
  - edit allows read + edits to the workspace, with those same secret files ignored.
  - auto has the same permissions as edit, but also reviews all tool calls and secret file read/edits via a custom guardian agent.

- permissions-mode - allows you to pick whether low-confidence auto-reviews are sent to the human (more precise), or immediately blocked (more autonomous).


## Attributions

This plugin is based off of another [permissions plugin by prateekmedia](https://github.com/prateekmedia/pi-hooks/tree/e55a50f9c5386504208e32ed059c099cfdc30611/permission).

See [LICENSE.md](./LICENSE.md) for more information.
