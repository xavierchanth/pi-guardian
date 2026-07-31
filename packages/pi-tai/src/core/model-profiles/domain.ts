export const PROFILE_CYCLE_SHORTCUT = "shift+tab";

export const THINKING_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number];

export interface ModelProfile {
  name: string;
  provider: string;
  model: string;
  effort: ThinkingEffort;
}

export const DEFAULT_MODEL_PROFILES: readonly ModelProfile[] = Object.freeze([
  Object.freeze({
    name: "sol-low",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    effort: "low",
  }),
  Object.freeze({
    name: "sol-medium",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    effort: "medium",
  }),
  Object.freeze({
    name: "sol-high",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    effort: "high",
  }),
]);
