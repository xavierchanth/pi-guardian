import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { subagentActivityProvider } from "../../core/subagents/activity.ts";
import { type FooterSnapshot, type FooterUsage, renderFooterRows } from "./render.ts";

export function registerFooter(pi: ExtensionAPI): void {
  let disposeActivitySubscription: (() => void) | undefined;
  const dispose = () => {
    disposeActivitySubscription?.();
    disposeActivitySubscription = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    dispose();
    if (ctx.mode !== "tui") return;

    const activity = subagentActivityProvider(pi);
    ctx.ui.setFooter((tui, theme) => {
      dispose();
      disposeActivitySubscription = activity.subscribe(() => tui.requestRender());
      return {
        invalidate() {},
        render(width: number): string[] {
          return renderFooterRows(createSnapshot(pi, ctx, activity.read()), width).map(
            (row) => theme.fg(row.leftColor, row.left) + theme.fg("text", row.padding + row.right),
          );
        },
      };
    });
  });

  pi.on("session_shutdown", dispose);
}

function createSnapshot(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  subagents: FooterSnapshot["subagents"],
): FooterSnapshot {
  const usage: FooterUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };

  const entries = ctx.sessionManager.getEntries();
  for (const entry of entries) {
    const entryUsage = billedUsage(entry);
    if (!entryUsage) continue;
    usage.input += entryUsage.input;
    usage.output += entryUsage.output;
    usage.cacheRead += entryUsage.cacheRead;
    usage.cacheWrite += entryUsage.cacheWrite;
    usage.cost += entryUsage.cost.total;
  }

  const context = ctx.getContextUsage();
  const model = ctx.model;
  return {
    cwd: ctx.cwd,
    usage,
    contextWindow: context?.contextWindow ?? model?.contextWindow ?? 0,
    contextPercent: context?.percent ?? null,
    usingSubscription: model ? ctx.modelRegistry.isUsingOAuth(model) : false,
    model: model?.id ?? "no-model",
    reasoning: model?.reasoning ?? false,
    thinkingLevel: pi.getThinkingLevel(),
    subagents,
  };
}

function billedUsage(entry: SessionEntry): Usage | undefined {
  if (entry.type === "message") {
    const message = entry.message as typeof entry.message & { usage?: Usage };
    return message.role === "assistant" || message.role === "toolResult"
      ? message.usage
      : undefined;
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return (entry as typeof entry & { usage?: Usage }).usage;
  }
  return undefined;
}
