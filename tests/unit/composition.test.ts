import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiTaiExtension } from "../../packages/pi-tai/extension.ts";

test("composition root registers every feature once in order", async () => {
  const calls: string[] = [];
  const extension = createPiTaiExtension({
    taskContext: () => {
      calls.push("task-context");
    },
    modes: async () => {
      calls.push("modes");
    },
    ansiTheme: () => {
      calls.push("ansi-theme");
    },
  });

  await extension({} as ExtensionAPI);

  assert.deepEqual(calls, ["task-context", "modes", "ansi-theme"]);
});
