import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const CONTEXT_IMPORT_TYPE = "pi-tai:context-import";

export function registerContextImportRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(CONTEXT_IMPORT_TYPE, (message, _options, theme) => {
    const summary = summaryFrom(message);
    const excerpt = summary.replace(/\s+/g, " ").slice(0, 120);
    const suffix = summary.length > 120 ? "…" : "";
    return new Text(
      theme.fg("accent", "Context import") + theme.fg("muted", ` — ${excerpt}${suffix}`),
      0,
      0,
    );
  });
}

function summaryFrom(message: {
  content: string | Array<{ type: string; text?: string }>;
  details?: unknown;
}): string {
  if (typeof message.details === "object" && message.details && "summary" in message.details) {
    return String((message.details as { summary: unknown }).summary);
  }
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}
