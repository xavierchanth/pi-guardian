export const BTW_ENTRY_TYPE = "pi-tai:btw";
export const BTW_TIMEOUT_MS = 45_000;
export const BTW_MAX_IN_FLIGHT = 2;
export const BTW_OMISSION_MARKER = "[Earlier or incomplete session context omitted to fit the model window.]";

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

export function estimatedTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function toolCallIds(message: Message): string[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content
    .filter((part): part is { type: string; id: string } =>
      typeof part === "object" && part !== null && (part as any).type === "toolCall" && typeof (part as any).id === "string")
    .map((part) => part.id);
}

/** Build only complete conversational/tool groups. Orphan results and incomplete calls are dropped. */
function coherentGroups(messages: readonly Message[]): { groups: Message[][]; sanitized: boolean } {
  const groups: Message[][] = [];
  let sanitized = false;
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!;
    if (message.role === "toolResult") {
      sanitized = true;
      index++;
      continue;
    }
    const ids = toolCallIds(message);
    if (ids.length === 0) {
      groups.push([message]);
      index++;
      continue;
    }
    const results: Message[] = [];
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor]!.role === "toolResult") {
      results.push(messages[cursor]!);
      cursor++;
    }
    const resultIds = results.map((result) => result.toolCallId).filter((id): id is string => typeof id === "string");
    if (results.length === ids.length && ids.every((id) => resultIds.includes(id)) && resultIds.every((id) => ids.includes(id))) {
      groups.push([message, ...results]);
    } else {
      sanitized = true;
    }
    index = cursor;
  }
  return { groups, sanitized };
}

/** Keep newest complete groups within the hard estimated-token budget. */
export function boundContext(messages: readonly Message[], tokenBudget: number): {
  messages: Message[];
  truncated: boolean;
} {
  const { groups, sanitized } = coherentGroups(messages);
  const marker: Message = { role: "user", content: BTW_OMISSION_MARKER };
  const markerSize = estimatedTokens(marker);
  const kept: Message[][] = [];
  let used = 0;
  let truncated = sanitized;
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index]!;
    const groupSize = estimatedTokens(group);
    const reserve = index > 0 || truncated ? markerSize : 0;
    if (used + groupSize + reserve > tokenBudget) {
      truncated = true;
      break;
    }
    kept.unshift(group);
    used += groupSize;
  }
  // Once anything was omitted, the marker itself is part of the hard limit. Drop oldest groups
  // if sanitization discovered the omission only after they were selected.
  while (truncated && kept.length && used + markerSize > tokenBudget) {
    used -= estimatedTokens(kept.shift()!);
  }
  // Measure the exact outbound array as the final authority (array punctuation can differ from the
  // sum of group estimates), always removing a whole coherent group.
  const exact = () => [...(truncated && markerSize <= tokenBudget ? [marker] : []), ...kept.flat()];
  while (kept.length && estimatedTokens(exact()) > tokenBudget) kept.shift();
  const bounded = exact();
  if (estimatedTokens(bounded) > tokenBudget) bounded.length = 0;
  return { messages: bounded, truncated };
}

export function answerText(content: readonly { type: string; text?: string }[], maxChars: number): {
  text: string;
  truncated: boolean;
} {
  const text = content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  if (!text.trim()) throw new Error("Model returned an empty answer.");
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`, truncated: true };
}
