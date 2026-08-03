import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PROFILE_CYCLE_SHORTCUT,
  provisionFirstPartyKeybindings,
  registerFirstPartyKeybindings,
  THINKING_CYCLE_KEYBINDING,
  THINKING_CYCLE_SHORTCUT,
} from "../../packages/pi-tai/src/terminal/keybindings/register.ts";

function temporaryAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-tai-keybindings-"));
}

function readKeybindings(agentDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(agentDir, "keybindings.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

test("first-party keybindings free Shift+Tab and bind native thinking cycling", () => {
  const agentDir = temporaryAgentDir();
  const result = provisionFirstPartyKeybindings(agentDir);

  assert.equal(result.changed, true);
  assert.deepEqual(readKeybindings(agentDir), {
    [THINKING_CYCLE_KEYBINDING]: [THINKING_CYCLE_SHORTCUT],
  });
});

test("first-party keybindings preserve unrelated and additional user bindings", () => {
  const agentDir = temporaryAgentDir();
  writeFileSync(
    join(agentDir, "keybindings.json"),
    JSON.stringify({
      "app.model.select": "ctrl+m",
      [THINKING_CYCLE_KEYBINDING]: ["ctrl+r", PROFILE_CYCLE_SHORTCUT, "CTRL+R"],
    }),
  );

  const result = provisionFirstPartyKeybindings(agentDir);

  assert.equal(result.changed, true);
  assert.deepEqual(readKeybindings(agentDir), {
    "app.model.select": "ctrl+m",
    [THINKING_CYCLE_KEYBINDING]: ["ctrl+r", THINKING_CYCLE_SHORTCUT],
  });
  assert.equal(provisionFirstPartyKeybindings(agentDir).changed, false);
});

test("invalid keybindings JSON is preserved and reported", () => {
  const agentDir = temporaryAgentDir();
  const path = join(agentDir, "keybindings.json");
  writeFileSync(path, "{");

  const result = provisionFirstPartyKeybindings(agentDir);

  assert.equal(result.changed, false);
  assert.match(result.warning ?? "", /did not modify invalid JSON/);
  assert.equal(readFileSync(path, "utf8"), "{");
});

test("registration surfaces provisioning failures through Pi UI", () => {
  const agentDir = temporaryAgentDir();
  writeFileSync(join(agentDir, "keybindings.json"), "[]");
  let sessionStart: ((event: unknown, ctx: any) => void) | undefined;
  const pi = {
    on(event: string, handler: (event: unknown, ctx: any) => void) {
      if (event === "session_start") sessionStart = handler;
    },
  } as unknown as ExtensionAPI;

  registerFirstPartyKeybindings(pi, agentDir);

  const notifications: Array<{ message: string; level: string }> = [];
  sessionStart?.(
    {},
    {
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    },
  );
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]?.message ?? "", /expected a JSON object/);
  assert.equal(notifications[0]?.level, "warning");
});
