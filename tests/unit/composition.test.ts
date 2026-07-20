import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiTaiExtension } from "../../packages/pi-tai/extension.ts";
import { createPiTaiConfigService } from "../../packages/pi-tai/src/config/register.ts";

test("composition root registers every feature once in order", async () => {
  const calls: string[] = [];
  const extension = createPiTaiExtension(
    {
      config: () => {
        calls.push("config");
      },
      taskContext: () => {
        calls.push("task-context");
      },
      modes: async () => {
        calls.push("modes");
      },
      ansiTheme: () => {
        calls.push("ansi-theme");
      },
    },
    () => ({ config: createPiTaiConfigService() }),
  );

  await extension({} as ExtensionAPI);

  assert.deepEqual(calls, ["config", "task-context", "modes", "ansi-theme"]);
});
