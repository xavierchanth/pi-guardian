export const BTW_ENTRY_TYPE = "pi-tai:btw";
export const BTW_TIMEOUT_MS = 45_000;
export const BTW_MAX_IN_FLIGHT = 2;

export type BtwEntry = {
  state: "success" | "error";
  question: string;
  answer?: string;
  error?: string;
  model: string;
  timestamp: string;
  truncation: { input: boolean; output: boolean };
};

type Message = { role: string; content: unknown; [key: string]: unknown };

function size(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

/** Trim whole conversational/tool groups from the oldest end. */
export function boundContext(messages: readonly Message[], tokenBudget: number): {
  messages: Message[];
  truncated: boolean;
} {
  const groups: Message[][] = [];
  for (const message of messages) {
    if (message.role === "toolResult" && groups.length) groups.at(-1)!.push(message);
    else groups.push([message]);
  }
  let total = groups.reduce((n, group) => n + size(group), 0);
  let truncated = false;
  while (groups.length > 1 && total > tokenBudget) {
    total -= size(groups.shift()!);
    truncated = true;
  }
  const kept = groups.flat();
  if (truncated) {
    kept.unshift({
      role: "user",
      content: "[Earlier session context omitted to fit the model window.]",
      timestamp: Date.now(),
    });
  }
  return { messages: kept, truncated };
}

export function answerText(content: readonly { type: string; text?: string }[], maxChars: number): {
  text: string;
  truncated: boolean;
} {
  const text = content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`, truncated: true };
}
