export const MODEL_PROFILE_IDS = ["thinker", "worker", "mechanical"] as const;
export type ModelProfileId = (typeof MODEL_PROFILE_IDS)[number];
export type ThinkingEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelProfile {
  id: ModelProfileId;
  description: string;
  provider: string;
  model: string;
  effort: ThinkingEffort;
}

export const MODEL_PROFILES: readonly ModelProfile[] = Object.freeze([
  Object.freeze({
    id: "thinker",
    description: "Work requiring investigation, planning, architecture, or substantial judgment.",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    effort: "high",
  }),
  Object.freeze({
    id: "worker",
    description: "Clearly planned work that still requires trusted engineering judgment.",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    effort: "low",
  }),
  Object.freeze({
    id: "mechanical",
    description: "Explicit repetitive transformations requiring minimal discretionary judgment.",
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    effort: "high",
  }),
]);
