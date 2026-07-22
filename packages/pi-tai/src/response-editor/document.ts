import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const RESPONSE_OPEN_TAG = "<response>";
export const RESPONSE_CLOSE_TAG = "</response>";

export type ResponseExtraction =
  | { kind: "response"; text: string }
  | { kind: "missing-opening-tag" };

export function findLastAssistantText(entries: readonly SessionEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "message" || entry.message.role !== "assistant") continue;

    const text = entry.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) return text;
  }

  return undefined;
}

export function formatResponseDocument(preview: string, draft = ""): string {
  const safePreview = escapeResponseTags(preview.trim());
  return [
    "<!-- pi-tai: preview only; content outside the response block is never submitted -->",
    "## Last agent message (preview only)",
    "",
    "<agent-message>",
    safePreview,
    "</agent-message>",
    "",
    "## Your response",
    "",
    RESPONSE_OPEN_TAG,
    draft,
    RESPONSE_CLOSE_TAG,
  ].join("\n");
}

export function extractResponse(document: string): ResponseExtraction {
  const openingIndex = document.indexOf(RESPONSE_OPEN_TAG);
  if (openingIndex < 0) return { kind: "missing-opening-tag" };

  const responseStart = openingIndex + RESPONSE_OPEN_TAG.length;
  const closingIndex = document.lastIndexOf(RESPONSE_CLOSE_TAG);
  const responseEnd = closingIndex < responseStart ? document.length : closingIndex;
  let text = document.slice(responseStart, responseEnd);

  // Remove only the line breaks supplied by the scaffold. User whitespace remains intact.
  text = text.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  return { kind: "response", text };
}

function escapeResponseTags(preview: string): string {
  return preview.replace(/<\/?response>/gi, (tag) => tag.replace("<", "&lt;").replace(">", "&gt;"));
}
