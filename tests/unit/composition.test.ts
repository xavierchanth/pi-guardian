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
      config: () => {
        calls.push("config");
      },
      capabilities: () => {
        calls.push("capabilities");
      },
      workContext: () => {
        calls.push("work-context");
      },
      responseEditor: () => {
        calls.push("response-editor");
      },
      workspaces: () => {
        calls.push("workspaces");
      },
      subagents: () => {
        calls.push("subagents");
      },
      sessionTitle: () => {
        calls.push("session-title");
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
    "config",
    "capabilities",
    "work-context",
    "response-editor",
    "workspaces",
    "subagents",
    "session-title",
    "notifications",
    "guardian",
    "footer",
    "ansi-theme",
  ]);
});
