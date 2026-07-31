import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiTaiExtension } from "../../packages/pi-tai/pi-tai.ts";
import { createPiTaiConfigService } from "../../packages/pi-tai/src/core/config/register.ts";

test("composition root registers every feature once in order", async () => {
  const calls: string[] = [];
  const extension = createPiTaiExtension(
    {
      keybindings: () => {
        calls.push("keybindings");
      },
      config: () => {
        calls.push("config");
      },
      compaction: () => {
        calls.push("compaction");
      },
      contextTransfer: () => {
        calls.push("context-transfer");
      },
      responseEditor: () => {
        calls.push("response-editor");
      },
      modelProfiles: () => {
        calls.push("model-profiles");
      },
      subagents: () => {
        calls.push("subagents");
      },
      sidebar: () => {
        calls.push("sidebar");
      },
      cmux: () => {
        calls.push("cmux");
      },
      notifications: () => {
        calls.push("notifications");
      },
      guardian: async () => {
        calls.push("guardian");
      },
      footer: () => {
        calls.push("footer");
      },
      ansiTheme: () => {
        calls.push("ansi-theme");
      },
    },
    () => ({
      mode: "pi-cli",
      config: createPiTaiConfigService(),
      queryTerminalBackground: async () => undefined,
      notificationSender: () => undefined,
      agentDir: "/tmp/pi-tai-test-agent",
    }),
  );

  await extension({} as ExtensionAPI);

  assert.deepEqual(calls, [
    "keybindings",
    "config",
    "compaction",
    "context-transfer",
    "response-editor",
    "model-profiles",
    "subagents",
    "sidebar",
    "cmux",
    "notifications",
    "guardian",
    "footer",
    "ansi-theme",
  ]);
});
