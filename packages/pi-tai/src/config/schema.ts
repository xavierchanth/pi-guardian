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

export interface PiTaiConfig {
  sessionTitle: SessionTitleConfig;
  ansiTheme: AnsiThemeConfig;
  notifications: NotificationsConfig;
  compaction: CompactionConfig;
  modelProfiles: readonly ModelProfile[];
}

export const DEFAULT_PI_TAI_CONFIG: PiTaiConfig = Object.freeze({
  sessionTitle: Object.freeze({
    effort: "minimal",
    maxWords: 6,
    fallback: "heuristic",
  }),
  ansiTheme: Object.freeze({
    darkTheme: "ansi-dark",
    lightTheme: "ansi-light",
    pollIntervalMs: 2000,
  }),
  notifications: Object.freeze({
    reviewFailure: true,
    agentCompletion: true,
  }),
  compaction: Object.freeze({
    enabled: true,
    thresholdPercent: 90,
  }),
  modelProfiles: DEFAULT_MODEL_PROFILES,
});
