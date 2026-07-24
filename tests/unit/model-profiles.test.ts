import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiTaiConfigService } from "../../packages/pi-tai/src/config/register.ts";
import { DEFAULT_PI_TAI_CONFIG } from "../../packages/pi-tai/src/config/schema.ts";
import { DEFAULT_MODEL_PROFILES } from "../../packages/pi-tai/src/model-profiles/domain.ts";
import {
  matchingProfile,
  registerModelProfiles,
} from "../../packages/pi-tai/src/model-profiles/register.ts";

type CommandHandler = (args: string, ctx: any) => Promise<void>;

function createHarness(options: {
  model?: unknown;
  canSelect?: boolean;
  appliedEffort?: string;
} = {}) {
  const commands = new Map<string, CommandHandler>();
  const shortcuts = new Map<string, (ctx: any) => Promise<void>>();
  const notifications: Array<{ message: string; level: string }> = [];
  const selectedModels: unknown[] = [];
  const selectedEfforts: string[] = [];
  const pi = {
    registerCommand(name: string, command: { handler: CommandHandler }) {
      commands.set(name, command.handler);
    },
    registerShortcut(key: string, shortcut: { handler: (ctx: any) => Promise<void> }) {
      shortcuts.set(key, shortcut.handler);
    },
    async setModel(model: unknown) {
      selectedModels.push(model);
      return options.canSelect ?? true;
    },
    setThinkingLevel(effort: string) {
      selectedEfforts.push(effort);
    },
    getThinkingLevel() {
      return options.appliedEffort ?? selectedEfforts.at(-1) ?? "off";
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: false,
    model: { provider: "openai-codex", id: "gpt-5.6-sol" },
    modelRegistry: { find: () => options.model },
    ui: {
      notify(message: string, level: string) { notifications.push({ message, level }); },
      select: async () => undefined,
    },
  };
  const config = {
    current: () => DEFAULT_PI_TAI_CONFIG,
  } as PiTaiConfigService;
  return {
    pi, ctx, config, commands, shortcuts, notifications, selectedModels, selectedEfforts,
  };
}

test("default profiles are Sol low, medium, and high in cycling order", () => {
  assert.deepEqual(DEFAULT_MODEL_PROFILES, [
    { name: "sol-low", provider: "openai-codex", model: "gpt-5.6-sol", effort: "low" },
    { name: "sol-medium", provider: "openai-codex", model: "gpt-5.6-sol", effort: "medium" },
    { name: "sol-high", provider: "openai-codex", model: "gpt-5.6-sol", effort: "high" },
  ]);
});

test("profile command and Shift+Tab select model before effort", async () => {
  const target = { provider: "openai-codex", id: "gpt-5.6-sol" };
  const harness = createHarness({ model: target });
  registerModelProfiles(harness.pi, harness.config);
  assert.deepEqual([...harness.commands.keys()], ["profile", "effort"]);
  assert.ok(harness.shortcuts.has("shift+tab"));

  await harness.commands.get("profile")?.("sol-high", harness.ctx);
  assert.deepEqual(harness.selectedModels, [target]);
  assert.deepEqual(harness.selectedEfforts, ["high"]);
  assert.match(harness.notifications[0]?.message ?? "", /sol-high/);
});

test("profile model failures do not change effort", async () => {
  const missing = createHarness();
  registerModelProfiles(missing.pi, missing.config);
  await missing.commands.get("profile")?.("sol-low", missing.ctx);
  assert.deepEqual(missing.selectedEfforts, []);
  assert.match(missing.notifications[0]?.message ?? "", /not registered/);

  const denied = createHarness({ model: {}, canSelect: false });
  registerModelProfiles(denied.pi, denied.config);
  await denied.commands.get("profile")?.("sol-low", denied.ctx);
  assert.deepEqual(denied.selectedEfforts, []);
  assert.match(denied.notifications[0]?.message ?? "", /no credentials/);
});

test("effort command changes effort independently and reports clamping", async () => {
  const harness = createHarness({ appliedEffort: "medium" });
  registerModelProfiles(harness.pi, harness.config);
  await harness.commands.get("effort")?.("high", harness.ctx);
  assert.deepEqual(harness.selectedEfforts, ["high"]);
  assert.match(harness.notifications[0]?.message ?? "", /requested high effort; applied medium/i);
});

test("matching profile is derived from actual provider, model, and effort", () => {
  assert.equal(
    matchingProfile(DEFAULT_MODEL_PROFILES, "openai-codex", "gpt-5.6-sol", "low")?.name,
    "sol-low",
  );
  assert.equal(
    matchingProfile(DEFAULT_MODEL_PROFILES, "openai-codex", "gpt-5.6-sol", "medium")?.name,
    "sol-medium",
  );
});
