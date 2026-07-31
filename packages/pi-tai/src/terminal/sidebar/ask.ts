import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import { answerText, boundContext, estimatedTokens } from "./domain.ts";

const SYSTEM_PROMPT =
  "Answer a one-off side question about this in-progress coding session. Use the supplied session context, but do not claim to use tools: none are available. Your answer is shown only to the user and will not be seen by the coding agent.";

export class BtwContextTooLargeError extends Error {
  override readonly name = "BtwContextTooLargeError";
}

export async function askBtw(input: {
  model: Model<any>;
  auth: { apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> };
  messages: readonly any[];
  question: string;
  effort: any;
  signal: AbortSignal;
}): Promise<{ answer: string; inputTruncated: boolean; outputTruncated: boolean }> {
  const questionMessage = { role: "user", content: input.question, timestamp: Date.now() };
  const fixedTokens = estimatedTokens(SYSTEM_PROMPT) + estimatedTokens(questionMessage);
  const available = input.model.contextWindow - fixedTokens;
  if (available < 512)
    throw new BtwContextTooLargeError(
      "Question and system prompt leave too little room for an answer.",
    );
  const outputTokens = Math.min(input.model.maxTokens, 2048, Math.floor(available / 2));
  const inputBudget = available - outputTokens;
  const bounded = boundContext(input.messages, inputBudget);
  const response = await completeSimple(
    input.model,
    {
      systemPrompt: SYSTEM_PROMPT,
      messages: [...bounded.messages, questionMessage] as any,
    },
    {
      apiKey: input.auth.apiKey,
      headers: input.auth.headers,
      env: input.auth.env,
      reasoning: input.effort,
      maxTokens: outputTokens,
      maxRetries: 0,
      signal: input.signal,
    },
  );
  const answer = answerText(response.content as any, outputTokens * 4);
  return {
    answer: answer.text,
    inputTruncated: bounded.truncated,
    outputTruncated: answer.truncated || response.stopReason === "length",
  };
}
