import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPiTaiConfig, type LoadedPiTaiConfig } from "./load.ts";
import {
  FIELD_DESCRIPTORS,
  type ConfigProvenance,
  type FieldOrigin,
} from "./provenance.ts";
import {
  DEFAULT_PI_TAI_CONFIG,
  type ClientPreferences,
  type HostMachineConfig,
  type ResolvedPiTaiConfig,
  type SessionPolicy,
} from "./schema.ts";

export interface SessionPolicyReader {
  sessionPolicy(): SessionPolicy;
}

export interface ClientPreferencesReader {
  clientPreferences(): ClientPreferences;
}

export interface PiTaiConfigService extends SessionPolicyReader, ClientPreferencesReader {
  hostMachine(): HostMachineConfig;
  provenance(): ConfigProvenance;
  reload(ctx: ExtensionContext): LoadedPiTaiConfig;
}

export function createPinnedPiTaiConfigService(
  policy: SessionPolicy,
  provenance: ConfigProvenance,
): PiTaiConfigService {
  const config: ResolvedPiTaiConfig = Object.freeze({
    ...DEFAULT_PI_TAI_CONFIG,
    sessionPolicy: policy,
  });
  return {
    sessionPolicy: () => policy,
    clientPreferences: () => config.clientPreferences,
    hostMachine: () => config.hostMachine,
    provenance: () => provenance,
    reload: () => ({
      config,
      provenance,
      warnings: [],
      globalPath: "",
      projectPath: "",
    }),
  };
}

export function createPiTaiConfigService(agentDir?: string): PiTaiConfigService {
  let current: ResolvedPiTaiConfig = DEFAULT_PI_TAI_CONFIG;
  let provenance: ConfigProvenance = Object.freeze(Object.fromEntries(
    Object.keys(FIELD_DESCRIPTORS).map((path) => [path, { layer: "default" } satisfies FieldOrigin]),
  ));
  return {
    sessionPolicy: () => current.sessionPolicy,
    clientPreferences: () => current.clientPreferences,
    hostMachine: () => current.hostMachine,
    provenance: () => provenance,
    reload(ctx) {
      const loaded = loadPiTaiConfig({
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
        agentDir,
      });
      current = loaded.config;
      provenance = loaded.provenance;
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
