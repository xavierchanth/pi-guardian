import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import { answerText, boundContext } from "./domain.ts";

export async function askBtw(input: {
  model: Model<any>;
  auth: { apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> };
  messages: readonly any[];
  question: string;
  effort: any;
  signal: AbortSignal;
}): Promise<{ answer: string; inputTruncated: boolean; outputTruncated: boolean }> {
  // Keep room for the system prompt, question, and a useful answer.
  const outputTokens = Math.max(256, Math.min(input.model.maxTokens ?? 4096, 2048));
  const inputBudget = Math.max(1024, input.model.contextWindow - outputTokens - 1024);
  const bounded = boundContext(input.messages, inputBudget);
  const response = await completeSimple(input.model, {
    systemPrompt: "Answer a one-off side question about this in-progress coding session. Use the supplied session context, but do not claim to use tools: none are available. Your answer is shown only to the user and will not be seen by the coding agent.",
    messages: [...bounded.messages, { role: "user", content: input.question, timestamp: Date.now() }] as any,
  }, {
    ...input.auth,
    reasoning: input.effort,
    maxTokens: outputTokens,
    maxRetries: 0,
    signal: input.signal,
  });
  const answer = answerText(response.content as any, outputTokens * 4);
  return { answer: answer.text, inputTruncated: bounded.truncated, outputTruncated: answer.truncated || response.stopReason === "length" };
}
