import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiTaiExtension } from "../../packages/pi-tai/extension.ts";
import { createPiTaiConfigService } from "../../packages/pi-tai/src/config/register.ts";
import { createPiSessionWorkContextStore } from "../../packages/pi-tai/src/work-context/persistence.ts";

test("composition root registers every feature once in order", async () => {
  const calls: string[] = [];
  const extension = createPiTaiExtension(
    {
      config: () => {
        calls.push("config");
      },
      workContext: () => {
        calls.push("work-context");
      },
      sessionTitle: () => {
        calls.push("session-title");
      },
      continueCommand: () => {
        calls.push("continue-command");
      },
      guardian: async () => {
        calls.push("guardian");
      },
      ansiTheme: () => {
        calls.push("ansi-theme");
      },
    },
    () => ({
      config: createPiTaiConfigService(),
      workContext: createPiSessionWorkContextStore(),
      titleGenerator: async () => "test title",
      queryTerminalBackground: async () => undefined,
    }),
  );

  await extension({} as ExtensionAPI);

  assert.deepEqual(calls, [
    "config",
    "work-context",
    "session-title",
    "continue-command",
    "guardian",
    "ansi-theme",
  ]);
});
