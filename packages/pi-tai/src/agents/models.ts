import type { BackendName } from "./domain.ts";

/**
 * How a spawn's model, effort, and harness are chosen.
 *
 * Three sources, narrowest first: what the caller wrote, what the alias implies,
 * what the harness defaults to. Keeping the table here means "give me luna"
 * lands the same way every time instead of depending on how the orchestrator
 * felt about it.
 */
export interface ModelChoice {
  readonly backend: BackendName;
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
}

/** What each harness runs when the caller names no model. */
export const BACKEND_DEFAULTS: Record<BackendName, Omit<ModelChoice, "backend">> = {
  pi: { provider: "openai-codex", model: "gpt-5.6-sol", effort: "low" },
  claude: { provider: "anthropic", model: "claude-opus-5", effort: "medium" },
  codex: { provider: "openai-codex", model: "gpt-5.6-sol", effort: "low" },
};

/**
 * Short names the orchestrator may pass as `model`.
 *
 * Each alias carries the harness it prefers, so asking for "fable" gets Claude
 * without also having to say so — but naming a harness explicitly still wins.
 */
export const MODEL_ALIASES: Record<string, ModelChoice> = {
  /** The implementation workhorse, and the global default. */
  sol: { backend: "pi", provider: "openai-codex", model: "gpt-5.6-sol", effort: "low" },
  /** Design, planning, and review. */
  opus: { backend: "claude", provider: "anthropic", model: "claude-opus-5", effort: "medium" },
  /** Stronger than opus, and never a default — use it only when asked for. */
  fable: { backend: "claude", provider: "anthropic", model: "claude-fable-5", effort: "medium" },
};

export const MODEL_ALIAS_NAMES = Object.keys(MODEL_ALIASES).sort();

export type ResolveModelResult =
  | { readonly ok: true; readonly choice: ModelChoice }
  | { readonly ok: false; readonly reason: string };

export function resolveModel(input: {
  /** An alias, or an explicit `provider/model`. */
  readonly model?: string;
  readonly backend?: BackendName;
  readonly effort?: string;
}): ResolveModelResult {
  const alias = input.model ? MODEL_ALIASES[input.model.toLowerCase()] : undefined;
  if (alias) {
    // An explicit harness overrides the alias's preference but keeps its model:
    // "luna on codex" is a real request, and the alias should not fight it.
    const backend = input.backend ?? alias.backend;
    const defaults = BACKEND_DEFAULTS[backend];
    return {
      ok: true,
      choice: {
        backend,
        // Aliases are named by model, so an alias always supplies its own model —
        // except where the harness cannot run it, which the caller sees at spawn.
        provider: alias.provider,
        model: alias.model,
        effort: input.effort ?? alias.effort ?? defaults.effort,
      },
    };
  }

  const backend = input.backend ?? "pi";
  const defaults = BACKEND_DEFAULTS[backend];
  if (!input.model) {
    return { ok: true, choice: { backend, ...defaults, ...(input.effort ? { effort: input.effort } : {}) } };
  }

  const separator = input.model.indexOf("/");
  if (separator <= 0 || separator === input.model.length - 1) {
    return {
      ok: false,
      reason: `"${input.model}" is neither a known alias (${MODEL_ALIAS_NAMES.join(", ")}) nor a provider/model id.`,
    };
  }
  return {
    ok: true,
    choice: {
      backend,
      provider: input.model.slice(0, separator),
      model: input.model.slice(separator + 1),
      effort: input.effort ?? defaults.effort,
    },
  };
}
