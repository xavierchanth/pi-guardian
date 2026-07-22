import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  MODEL_PROFILES,
  type ModelProfile,
} from "./domain.ts";

export function registerModelProfiles(
  pi: ExtensionAPI,
  profiles: readonly ModelProfile[] = MODEL_PROFILES,
): void {
  for (const profile of profiles) {
    pi.registerCommand(`model:${profile.id}`, {
      description: `Switch to ${profile.provider}/${profile.model} with ${profile.effort} thinking`,
      handler: async (args, ctx) => {
        if (args.trim()) {
          ctx.ui.notify(`Usage: /model:${profile.id}`, "warning");
          return;
        }
        await applyModelProfile(pi, profile, ctx);
      },
    });
  }
}

export async function applyModelProfile(
  pi: ExtensionAPI,
  profile: ModelProfile,
  ctx: ExtensionCommandContext,
): Promise<boolean> {
  const model = ctx.modelRegistry.find(profile.provider, profile.model);
  const target = `${profile.provider}/${profile.model}`;
  if (!model) {
    ctx.ui.notify(`Model profile "${profile.id}" is unavailable: ${target} is not registered.`, "error");
    return false;
  }

  if (!await pi.setModel(model)) {
    ctx.ui.notify(`Model profile "${profile.id}" is unavailable: no credentials for ${target}.`, "error");
    return false;
  }

  pi.setThinkingLevel(profile.effort);
  const appliedEffort = pi.getThinkingLevel();
  if (appliedEffort !== profile.effort) {
    ctx.ui.notify(
      `Switched to model profile "${profile.id}": ${target}; requested ${profile.effort} thinking, applied ${appliedEffort}.`,
      "warning",
    );
    return true;
  }

  ctx.ui.notify(`Switched to model profile "${profile.id}": ${target} (${appliedEffort} thinking).`, "info");
  return true;
}
