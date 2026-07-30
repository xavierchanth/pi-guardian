/** Typed subset of the Codex 0.145.0 app-server protocol used by this backend. */
export interface CodexRequests {
  initialize: {
    params: { clientInfo: { name: string; version: string } };
    result: Record<string, unknown>;
  };
  "modelProvider/capabilities/read": {
    params: Record<string, never>;
    result: ModelProviderCapabilities;
  };
  "configRequirements/read": {
    params: Record<string, never>;
    result: ConfigRequirementsReadResponse;
  };
  "thread/start": { params: Record<string, unknown>; result: Record<string, unknown> };
  "thread/resume": { params: { threadId: string }; result: Record<string, unknown> };
  "turn/start": { params: Record<string, unknown>; result: Record<string, unknown> };
  "turn/interrupt": {
    params: { threadId: string; turnId: string };
    result: Record<string, unknown>;
  };
}

export interface ModelProviderCapabilities {
  readonly webSearch: boolean;
  readonly imageGeneration: boolean;
  readonly namespaceTools: boolean;
}

export type WebSearchMode = "disabled" | "cached" | "live";
export interface ConfigRequirementsReadResponse {
  readonly requirements?: null | {
    readonly allowedWebSearchModes?: readonly WebSearchMode[] | null;
  };
}

export type CodexMethod = keyof CodexRequests;
export type CodexParams<M extends CodexMethod> = CodexRequests[M]["params"];
export type CodexResult<M extends CodexMethod> = CodexRequests[M]["result"];

export type ResearchAvailability =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: "unsupported" | "policy"; readonly reason: string };

/** Native support and administrative permission are separate, actionable failures. */
export function researchAvailability(
  capabilities: ModelProviderCapabilities,
  config: ConfigRequirementsReadResponse,
): ResearchAvailability {
  if (capabilities.webSearch !== true) {
    return {
      ok: false,
      kind: "unsupported",
      reason: "Codex app-server does not support native web search for this model provider.",
    };
  }
  const allowed = config.requirements?.allowedWebSearchModes;
  if (allowed && !allowed.includes("live")) {
    return {
      ok: false,
      kind: "policy",
      reason: "Codex policy blocks live web search (allowedWebSearchModes does not include live).",
    };
  }
  return { ok: true };
}
