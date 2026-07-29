import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface SummarizeContextInput { branch: readonly unknown[]; notes?: string; ctx: ExtensionContext }
export type ContextSummarizer = (input: SummarizeContextInput) => Promise<string>;

export function contextSummaryInstructions(notes?: string): string {
  return [
    "Summarize this coding session for transfer to another session.",
    "Include the goal, decisions with rationale, current state, next step, and unresolved ambiguities.",
    "Be compact but preserve concrete paths, commands, constraints, and important failures. Return only the summary.",
    ...(notes?.trim() ? [`Additional user notes for this summary: ${notes.trim()}`] : []),
  ].join("\n");
}

export const summarizeContextWithActiveModel: ContextSummarizer = async ({ branch, notes, ctx }) => {
  if (!ctx.model) throw new Error("No active model is selected.");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok) throw new Error("error" in auth ? auth.error : "Authentication failed.");
  const response = await completeSimple(ctx.model, {
    systemPrompt: contextSummaryInstructions(notes),
    messages: [{ role: "user", content: JSON.stringify(branch), timestamp: Date.now() }],
  }, { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, maxTokens: 2048, maxRetries: 0 });
  const summary = response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
  if (!summary) throw new Error("The model returned an empty context summary.");
  return summary;
};
