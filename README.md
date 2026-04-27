# pi-guardian

This is a plugin for [pi the coding agent](https://pi.dev).  
It is meant to bring the benefits of OpenAI Codex's auto-approval feature to pi.

## Story time

This is absolutely my favorite feature in Codex and I have a really cool story to share:

- The feature (in Codex) was originally experimental
- I turned it on immediately and it instantly had me hooked on codex
- Along the way, Codex app comes out, and I stick with it for a while
- An update to Codex causes the feature to disappear (turns out I needed to reenable the experimental flag :/)
- I eventually contacted support about the missing feature
- The feature goes stable in the next release
- It's a pretty boring story, but I appreciated being heard by their team

## Vibe-slop meter

- This is absolutely coded with AI. Do with that what you will.
- Do I think this is as good as it could be? no.
- Do I think it is likely to increase safety over having nothing? yes.

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
