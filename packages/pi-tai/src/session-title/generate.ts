import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionTitleConfig } from "../core/config/schema.ts";

export interface GenerateTitleInput {
  prompt: string;
  config: SessionTitleConfig;
  ctx: ExtensionContext;
  signal?: AbortSignal;
}

export type TitleGenerator = (input: GenerateTitleInput) => Promise<string>;

export const generateModelTitle: TitleGenerator = async ({ prompt, config, ctx, signal }) => {
  if (!config.provider || !config.model) {
    throw new Error("Session-title provider and model must both be configured.");
  }
  const model = ctx.modelRegistry.find(config.provider, config.model);
  if (!model) {
    throw new Error(`Session-title model not found: ${config.provider}/${config.model}`);
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);

  const response = await completeSimple(
    model,
    {
      systemPrompt: [
        "Create a concise title for a coding-agent session.",
        `Return only a plain title of at most ${config.maxWords} words.`,
        "Do not use quotation marks, Markdown, terminal punctuation, or commentary.",
      ].join("\n"),
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      reasoning: config.effort,
      maxTokens: 32,
      maxRetries: 0,
      signal,
    },
  );

  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join(" ");
};
