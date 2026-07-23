import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  MODEL_PROFILES,
  MODEL_PROFILE_IDS,
} from "../../packages/pi-tai/src/model-profiles/domain.ts";
import { registerModelProfiles } from "../../packages/pi-tai/src/model-profiles/register.ts";
import {
  DEFAULT_MODEL_PREFERENCES,
  MODEL_PREFERENCE_IDS,
} from "../../packages/pi-tai/src/subagents/domain.ts";

type CommandHandler = (args: string, ctx: any) => Promise<void>;

function createHarness(options: {
  model?: unknown;
  canSelect?: boolean;
  appliedEffort?: string;
} = {}) {
  const commands = new Map<string, CommandHandler>();
  const notifications: Array<{ message: string; level: string }> = [];
  const selectedModels: unknown[] = [];
  const selectedEfforts: string[] = [];
  const pi = {
    registerCommand(name: string, command: { handler: CommandHandler }) {
      commands.set(name, command.handler);
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
    modelRegistry: {
      find: () => options.model,
    },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };
  return { pi, ctx, commands, notifications, selectedModels, selectedEfforts };
}

test("subagents reuse the always-available model profile definitions", () => {
  assert.strictEqual(DEFAULT_MODEL_PREFERENCES, MODEL_PROFILES);
  assert.strictEqual(MODEL_PREFERENCE_IDS, MODEL_PROFILE_IDS);
  assert.deepEqual(MODEL_PROFILES.map(({ id, provider, model, effort }) => ({ id, provider, model, effort })), [
    { id: "designer", provider: "opencode-go", model: "kimi-k3", effort: "max" },
    { id: "thinker", provider: "openai-codex", model: "gpt-5.6-sol", effort: "high" },
    { id: "worker", provider: "openai-codex", model: "gpt-5.6-sol", effort: "low" },
    { id: "mechanical", provider: "openai-codex", model: "gpt-5.6-luna", effort: "high" },
  ]);
});

test("model profile commands register exact names and switch model plus effort", async () => {
  const targetModel = { provider: "opencode-go", id: "kimi-k3" };
  const harness = createHarness({ model: targetModel });
  registerModelProfiles(harness.pi);

  assert.deepEqual([...harness.commands.keys()], ["model:designer", "model:thinker", "model:worker", "model:mechanical"]);
  await harness.commands.get("model:designer")?.("", harness.ctx);

  assert.deepEqual(harness.selectedModels, [targetModel]);
  assert.deepEqual(harness.selectedEfforts, ["max"]);
  assert.deepEqual(harness.notifications, [{
    message: "Switched to model profile \"designer\": opencode-go/kimi-k3 (max thinking).",
    level: "info",
  }]);
});

test("model profile commands reject arguments without changing session state", async () => {
  const harness = createHarness({ model: {} });
  registerModelProfiles(harness.pi);

  await harness.commands.get("model:worker")?.("unexpected", harness.ctx);

  assert.deepEqual(harness.selectedModels, []);
  assert.deepEqual(harness.selectedEfforts, []);
  assert.match(harness.notifications[0]?.message ?? "", /Usage: \/model:worker/);
});

test("model profile commands report missing models and credentials without changing effort", async () => {
  const missing = createHarness();
  registerModelProfiles(missing.pi);
  await missing.commands.get("model:mechanical")?.("", missing.ctx);
  assert.deepEqual(missing.selectedModels, []);
  assert.deepEqual(missing.selectedEfforts, []);
  assert.match(missing.notifications[0]?.message ?? "", /is not registered/);
  assert.equal(missing.notifications[0]?.level, "error");

  const unauthenticated = createHarness({ model: {}, canSelect: false });
  registerModelProfiles(unauthenticated.pi);
  await unauthenticated.commands.get("model:worker")?.("", unauthenticated.ctx);
  assert.equal(unauthenticated.selectedModels.length, 1);
  assert.deepEqual(unauthenticated.selectedEfforts, []);
  assert.match(unauthenticated.notifications[0]?.message ?? "", /no credentials/);
  assert.equal(unauthenticated.notifications[0]?.level, "error");
});

test("model profile commands disclose model capability clamping", async () => {
  const harness = createHarness({ model: {}, appliedEffort: "medium" });
  registerModelProfiles(harness.pi);

  await harness.commands.get("model:thinker")?.("", harness.ctx);

  assert.deepEqual(harness.selectedEfforts, ["high"]);
  assert.match(harness.notifications[0]?.message ?? "", /requested high thinking, applied medium/);
  assert.equal(harness.notifications[0]?.level, "warning");
});
