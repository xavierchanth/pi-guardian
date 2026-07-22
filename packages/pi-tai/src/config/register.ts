import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPiTaiConfig, type LoadedPiTaiConfig } from "./load.ts";
import { DEFAULT_PI_TAI_CONFIG, type PiTaiConfig } from "./schema.ts";

export interface PiTaiConfigService {
  current(): PiTaiConfig;
  reload(ctx: ExtensionContext): LoadedPiTaiConfig;
}

export function createPiTaiConfigService(agentDir?: string): PiTaiConfigService {
  let current = DEFAULT_PI_TAI_CONFIG;
  return {
    current: () => current,
    reload(ctx) {
      const loaded = loadPiTaiConfig({
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
        agentDir,
      });
      current = loaded.config;
      return loaded;
    },
  };
}

export function registerPiTaiConfig(
  pi: ExtensionAPI,
  service: PiTaiConfigService,
): void {
  let lastWarningKey: string | undefined;
  pi.on("session_start", (_event, ctx) => {
    const loaded = service.reload(ctx);
    const warningKey = loaded.warnings.join("\n") || undefined;
    if (!warningKey || warningKey === lastWarningKey) return;
    lastWarningKey = warningKey;
    ctx.ui.notify(
      ["Pi-Tai configuration warning; invalid values were ignored.", ...loaded.warnings].join("\n"),
      "warning",
    );
  });
}
