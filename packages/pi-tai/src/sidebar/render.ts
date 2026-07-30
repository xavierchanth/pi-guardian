import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { BTW_ENTRY_TYPE, type BtwEntry } from "./domain.ts";

export function registerBtwRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer(BTW_ENTRY_TYPE, (entry, { expanded }, theme) => {
    const data = entry.data as BtwEntry;
    const container = new Container();
    const result = data.state === "success" ? data.answer ?? "" : data.error ?? "Unknown error";
    const collapsed = result.replace(/\s+/g, " ");
    const preview = collapsed.slice(0, 140) + (collapsed.length > 140 ? "…" : "");
    container.addChild(new Text(
      theme.fg(data.state === "success" ? "accent" : "error", "by the way") +
      theme.fg("muted", ` — ${preview}`), 0, 0,
    ));
    if (expanded) {
      container.addChild(new Text(theme.fg("muted", `Q: ${data.question}\n${data.model} · ${data.timestamp}`), 0, 1));
      container.addChild(new Markdown(result, 0, 0, getMarkdownTheme()));
    }
    return container;
  });
}
