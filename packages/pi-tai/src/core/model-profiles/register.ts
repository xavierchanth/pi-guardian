import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionPolicyReader } from "../config/register.ts";
import {
  PROFILE_CYCLE_SHORTCUT,
  THINKING_EFFORTS,
  type ModelProfile,
  type ThinkingEffort,
} from "./domain.ts";

export function registerModelProfiles(pi: ExtensionAPI, config: SessionPolicyReader): void {
  const profiles = () => config.sessionPolicy().modelProfiles;

  pi.registerCommand("profile", {
    description: "Select a configured model-and-effort profile",
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (requested) {
        const profile = profiles().find((entry) => entry.name === requested);
        if (!profile) {
          ctx.ui.notify(
            `Unknown model profile "${requested}". Available: ${profileNames(profiles())}.`,
            "error",
          );
          return;
        }
        await applyModelProfile(pi, profile, ctx);
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(`Available model profiles: ${profileNames(profiles())}.`, "info");
        return;
      }
      const selected = await ctx.ui.select(
        "Select model profile",
        profiles().map((profile) => `${profile.name} — ${profile.model} (${profile.effort})`),
      );
      const name = selected?.split(" — ", 1)[0];
      const profile = profiles().find((entry) => entry.name === name);
      if (profile) await applyModelProfile(pi, profile, ctx);
    },
  });

  pi.registerCommand("effort", {
    description: "Set reasoning effort independently of the selected model profile",
    handler: async (args, ctx) => {
      let effort = args.trim() as ThinkingEffort | "";
      if (!effort) {
        if (!ctx.hasUI) {
          ctx.ui.notify(
            `Current effort: ${pi.getThinkingLevel()}. Available: ${THINKING_EFFORTS.join(", ")}.`,
            "info",
          );
          return;
        }
        effort =
          ((await ctx.ui.select("Select reasoning effort", [...THINKING_EFFORTS])) as
            | ThinkingEffort
            | undefined) ?? "";
        if (!effort) return;
      }
      if (!THINKING_EFFORTS.includes(effort as ThinkingEffort)) {
        ctx.ui.notify(`Usage: /effort ${THINKING_EFFORTS.join("|")}`, "warning");
        return;
      }
      applyEffort(pi, effort as ThinkingEffort, ctx);
    },
  });

  pi.registerShortcut(PROFILE_CYCLE_SHORTCUT, {
    description: "Cycle configured model profiles",
    handler: async (ctx) => {
      const configured = profiles();
      if (configured.length === 0) {
        ctx.ui.notify("No model profiles are configured.", "warning");
        return;
      }
      const current = matchingProfile(
        configured,
        ctx.model?.provider,
        ctx.model?.id,
        pi.getThinkingLevel(),
      );
      const index = current ? configured.findIndex((entry) => entry.name === current.name) : -1;
      const next = configured[(index + 1) % configured.length];
      await applyModelProfile(pi, next, ctx);
    },
  });
}

export async function applyModelProfile(
  pi: ExtensionAPI,
  profile: ModelProfile,
  ctx: ExtensionContext,
): Promise<boolean> {
  const model = ctx.modelRegistry.find(profile.provider, profile.model);
  const target = `${profile.provider}/${profile.model}`;
  if (!model) {
    ctx.ui.notify(
      `Model profile "${profile.name}" is unavailable: ${target} is not registered.`,
      "error",
    );
    return false;
  }
  if (!(await pi.setModel(model))) {
    ctx.ui.notify(
      `Model profile "${profile.name}" is unavailable: no credentials for ${target}.`,
      "error",
    );
    return false;
  }
  pi.setThinkingLevel(profile.effort);
  const applied = pi.getThinkingLevel();
  if (applied !== profile.effort) {
    ctx.ui.notify(
      `Applied profile "${profile.name}": ${target}; requested ${profile.effort} effort, applied ${applied}.`,
      "warning",
    );
    return true;
  }
  ctx.ui.notify(`Applied profile "${profile.name}": ${target} (${applied}).`, "info");
  return true;
}

export function matchingProfile(
  profiles: readonly ModelProfile[],
  provider: string | undefined,
  model: string | undefined,
  effort: string,
): ModelProfile | undefined {
  return profiles.find(
    (profile) =>
      profile.provider === provider && profile.model === model && profile.effort === effort,
  );
}

function applyEffort(pi: ExtensionAPI, effort: ThinkingEffort, ctx: ExtensionContext): void {
  pi.setThinkingLevel(effort);
  const applied = pi.getThinkingLevel();
  ctx.ui.notify(
    applied === effort
      ? `Reasoning effort: ${applied}.`
      : `Requested ${effort} effort; applied ${applied}.`,
    applied === effort ? "info" : "warning",
  );
}

function profileNames(profiles: readonly ModelProfile[]): string {
  return profiles.map((profile) => profile.name).join(", ") || "none";
}
