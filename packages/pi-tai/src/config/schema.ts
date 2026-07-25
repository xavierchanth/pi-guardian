import {
  DEFAULT_MODEL_PROFILES,
  type ModelProfile,
} from "../model-profiles/domain.ts";

export const TITLE_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type TitleEffort = (typeof TITLE_EFFORTS)[number];

export interface SessionTitleConfig {
  provider?: string;
  model?: string;
  effort: TitleEffort;
  maxWords: number;
  fallback: "heuristic";
}

export interface AnsiThemeConfig {
  darkTheme: string;
  lightTheme: string;
  pollIntervalMs: number;
}

export interface NotificationsConfig {
  reviewFailure: boolean;
  agentCompletion: boolean;
}

export interface CompactionConfig {
  enabled: boolean;
  thresholdPercent: number;
}

/**
 * Host-owned, per-session, command-mutable policy. Selects models and spends tokens, so it is
 * resolved by the authority that owns the session rather than by whichever client is attached.
 */
export interface SessionPolicy {
  sessionTitle: SessionTitleConfig;
  compaction: CompactionConfig;
  modelProfiles: readonly ModelProfile[];
}

/**
 * Client-local presentation preferences. These never cross the wire: an editor client owns its
 * own theming and decides for itself how to surface notifications.
 */
export interface ClientPreferences {
  ansiTheme: AnsiThemeConfig;
  notifications: NotificationsConfig;
}

/**
 * Machine-scoped, admin-writable configuration. Deliberately empty until checkpoint 12 supplies
 * Guardian's reviewer model and timeout, which are security-sensitive and must land separately.
 * `Record<string, never>` rather than an empty interface so it admits only `{}`.
 */
export type HostMachineConfig = Record<string, never>;

export interface ResolvedPiTaiConfig {
  sessionPolicy: SessionPolicy;
  clientPreferences: ClientPreferences;
  hostMachine: HostMachineConfig;
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = Object.freeze({
  sessionTitle: Object.freeze({
    effort: "minimal",
    maxWords: 6,
    fallback: "heuristic",
  }),
  compaction: Object.freeze({
    enabled: true,
    thresholdPercent: 90,
  }),
  modelProfiles: DEFAULT_MODEL_PROFILES,
});

export const DEFAULT_CLIENT_PREFERENCES: ClientPreferences = Object.freeze({
  ansiTheme: Object.freeze({
    darkTheme: "ansi-dark",
    lightTheme: "ansi-light",
    pollIntervalMs: 2000,
  }),
  notifications: Object.freeze({
    reviewFailure: true,
    agentCompletion: true,
  }),
});

export const DEFAULT_HOST_MACHINE_CONFIG: HostMachineConfig = Object.freeze({});

export const DEFAULT_PI_TAI_CONFIG: ResolvedPiTaiConfig = Object.freeze({
  sessionPolicy: DEFAULT_SESSION_POLICY,
  clientPreferences: DEFAULT_CLIENT_PREFERENCES,
  hostMachine: DEFAULT_HOST_MACHINE_CONFIG,
});
