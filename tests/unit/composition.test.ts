import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiTaiExtension } from "../../packages/pi-tai/pi-tai.ts";
import { SessionCapabilityController } from "../../packages/pi-tai/src/capabilities/controller.ts";
import { createPiTaiConfigService } from "../../packages/pi-tai/src/config/register.ts";
import { createPiSessionWorkContextStore } from "../../packages/pi-tai/src/work-context/persistence.ts";

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
      capabilities: () => {
        calls.push("capabilities");
      },
      workContext: () => {
        calls.push("work-context");
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
      sessionTitle: () => {
        calls.push("session-title");
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
      workContext: createPiSessionWorkContextStore(),
      titleGenerator: async () => "test title",
      queryTerminalBackground: async () => undefined,
      notificationSender: () => undefined,
      capabilities: new SessionCapabilityController(),
      agentDir: "/tmp/pi-tai-test-agent",
    }),
  );

  await extension({} as ExtensionAPI);

  assert.deepEqual(calls, [
    "keybindings",
    "config",
    "compaction",
    "capabilities",
    "work-context",
    "context-transfer",
    "response-editor",
    "model-profiles",
    "subagents",
    "session-title",
    "cmux",
    "notifications",
    "guardian",
    "footer",
    "ansi-theme",
  ]);
});
