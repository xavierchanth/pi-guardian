import { readFileSync } from "node:fs";
import { BACKEND_NAMES, type BackendName } from "./domain.ts";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

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

export interface ModelAlias extends ModelChoice {
  readonly name: string;
  /** Harnesses that can faithfully run this model. */
  readonly allowedBackends: readonly BackendName[];
  readonly purpose: string;
}

export interface ModelCatalog {
  readonly version: 1;
  readonly aliases: readonly ModelAlias[];
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
 * The packaged JSON file is the maintainable source of truth. It is parsed once
 * at this trust boundary so the rest of the agent subsystem receives only valid
 * provider/model/harness combinations.
 */
export const MODEL_CATALOG = parseModelCatalog(JSON.parse(
  readFileSync(new URL("./models.json", import.meta.url), "utf8"),
));

export const MODEL_ALIASES: Readonly<Record<string, ModelAlias>> = Object.freeze(
  Object.fromEntries(MODEL_CATALOG.aliases.map((alias) => [alias.name, alias])),
);

export const MODEL_ALIAS_NAMES = Object.keys(MODEL_ALIASES).sort();

export function parseModelCatalog(input: unknown): ModelCatalog {
  const root = record(input, "catalog");
  exactKeys(root, ["version", "aliases"], "catalog");
  if (root.version !== 1) throw new Error("Model catalog version must be 1.");
  if (!Array.isArray(root.aliases) || root.aliases.length === 0) {
    throw new Error("Model catalog aliases must be a non-empty array.");
  }

  const names = new Set<string>();
  const aliases = root.aliases.map((value, index): ModelAlias => {
    const path = `aliases[${index}]`;
    const item = record(value, path);
    exactKeys(item, ["name", "backend", "provider", "model", "effort", "allowedBackends", "purpose"], path);
    const name = text(item.name, `${path}.name`).toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`${path}.name must be lowercase kebab-case.`);
    if (names.has(name)) throw new Error(`Duplicate model alias "${name}".`);
    names.add(name);

    const backend = backendName(item.backend, `${path}.backend`);
    const provider = text(item.provider, `${path}.provider`);
    const model = text(item.model, `${path}.model`);
    const effort = text(item.effort, `${path}.effort`);
    if (!EFFORT_LEVELS.includes(effort as (typeof EFFORT_LEVELS)[number])) {
      throw new Error(`${path}.effort must be one of: ${EFFORT_LEVELS.join(", ")}.`);
    }
    if (!Array.isArray(item.allowedBackends) || item.allowedBackends.length === 0) {
      throw new Error(`${path}.allowedBackends must be a non-empty array.`);
    }
    const allowedBackends = [...new Set(item.allowedBackends.map((entry, allowedIndex) =>
      backendName(entry, `${path}.allowedBackends[${allowedIndex}]`)))];
    if (!allowedBackends.includes(backend)) {
      throw new Error(`${path}.backend must appear in allowedBackends.`);
    }
    const required = constrainedBackends(provider, model);
    if (required && !sameBackends(allowedBackends, required)) {
      throw new Error(`${path}.allowedBackends must be exactly ${required.join(", ")} for ${provider}/${model}.`);
    }
    return Object.freeze({
      name, backend, provider, model, effort,
      allowedBackends: Object.freeze(allowedBackends),
      purpose: text(item.purpose, `${path}.purpose`),
    });
  });

  return Object.freeze({ version: 1, aliases: Object.freeze(aliases) });
}

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
    const backend = input.backend ?? alias.backend;
    if (!alias.allowedBackends.includes(backend)) {
      return incompatible(input.model!, backend, alias.allowedBackends);
    }
    const defaults = BACKEND_DEFAULTS[backend];
    return {
      ok: true,
      choice: {
        backend,
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
  const provider = input.model.slice(0, separator);
  const model = input.model.slice(separator + 1);
  const allowedBackends = constrainedBackends(provider, model);
  if (allowedBackends && !allowedBackends.includes(backend)) {
    return incompatible(input.model, backend, allowedBackends);
  }
  return {
    ok: true,
    choice: {
      backend,
      provider,
      model,
      effort: input.effort ?? defaults.effort,
    },
  };
}

function constrainedBackends(provider: string, model: string): readonly BackendName[] | undefined {
  const normalizedProvider = provider.toLowerCase();
  if (normalizedProvider === "anthropic" || /(^|\/)claude(?:-|$)/i.test(model)) return ["claude"];
  if (normalizedProvider === "opencode-go") return ["pi"];
  return undefined;
}

function sameBackends(left: readonly BackendName[], right: readonly BackendName[]): boolean {
  return left.length === right.length && left.every((backend) => right.includes(backend));
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`${path}.${key} is not a supported field.`);
  }
  for (const key of keys) {
    if (!(key in value)) throw new Error(`${path}.${key} is required.`);
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string.`);
  return value.trim();
}

function backendName(value: unknown, path: string): BackendName {
  if (typeof value !== "string" || !BACKEND_NAMES.includes(value as BackendName)) {
    throw new Error(`${path} must be one of: ${BACKEND_NAMES.join(", ")}.`);
  }
  return value as BackendName;
}

function incompatible(model: string, backend: BackendName, allowed: readonly BackendName[]): ResolveModelResult {
  return {
    ok: false,
    reason: `Model "${model}" cannot run on the ${backend} backend; use ${allowed.join(" or ")}.`,
  };
}
