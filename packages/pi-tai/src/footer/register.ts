import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkContextStore } from "../work-context/persistence.ts";
import { renderFooterRows, type FooterSnapshot, type FooterUsage } from "./render.ts";
import type { AgentRoleState } from "../subagents/state.ts";

export function registerFooter(
  pi: ExtensionAPI,
  workContext: WorkContextStore,
  agentRole?: AgentRoleState,
): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setFooter((_tui, theme) => ({
      invalidate() {},
      render(width: number): string[] {
        return renderFooterRows(createSnapshot(pi, ctx, workContext, agentRole), width).map(
          (row) =>
            theme.fg(row.leftColor, row.left) +
            theme.fg("text", row.padding + row.right),
        );
      },
    }));
  });
}

function createSnapshot(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  workContext: WorkContextStore,
  agentRole?: AgentRoleState,
): FooterSnapshot {
  const usage: FooterUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message as AssistantMessage;
    usage.input += message.usage.input;
    usage.output += message.usage.output;
    usage.cacheRead += message.usage.cacheRead;
    usage.cacheWrite += message.usage.cacheWrite;
    usage.cost += message.usage.cost.total;
  }

  const work = workContext.current();
  const activeIndex = work?.plan.findIndex((item) => item.status === "in_progress") ?? -1;
  const active = activeIndex >= 0 ? work?.plan[activeIndex] : undefined;
  const complete = Boolean(
    work?.plan.length && work.plan.every((item) => item.status === "completed"),
  );
  const context = ctx.getContextUsage();
  const model = ctx.model;
  return {
    cwd: ctx.cwd,
    goal: work?.goal,
    currentStep: active?.content ?? (complete ? "Complete" : undefined),
    currentStepNumber: active ? activeIndex + 1 : complete ? work?.plan.length : undefined,
    totalSteps: work?.plan.length ?? 0,
    usage,
    contextWindow: context?.contextWindow ?? model?.contextWindow ?? 0,
    contextPercent: context?.percent ?? null,
    usingSubscription: model ? ctx.modelRegistry.isUsingOAuth(model) : false,
    model: model?.id ?? "no-model",
    reasoning: model?.reasoning ?? false,
    thinkingLevel: pi.getThinkingLevel(),
    agentRole: agentRole?.current() ?? "standalone",
  };
}
