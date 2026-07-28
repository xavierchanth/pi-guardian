import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionCapabilityController } from "../capabilities/controller.ts";
import { reconstructSubagentState } from "../subagents/domain.ts";
import type { WorkContextStore } from "../work-context/persistence.ts";
import { renderFooterRows, type FooterSnapshot, type FooterUsage } from "./render.ts";

export function registerFooter(
  pi: ExtensionAPI,
  workContext: WorkContextStore,
  capabilities: SessionCapabilityController,
): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setFooter((_tui, theme) => ({
      invalidate() {},
      render(width: number): string[] {
        return renderFooterRows(createSnapshot(pi, ctx, workContext, capabilities), width).map(
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
  capabilities: SessionCapabilityController,
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

  const work = workContext.current();
  const activeIndex = work?.plan.findIndex((item) => item.status === "in_progress") ?? -1;
  const active = activeIndex >= 0 ? work?.plan[activeIndex] : undefined;
  const complete = Boolean(
    work?.plan.length && work.plan.every((item) => item.status === "completed"),
  );
  const context = ctx.getContextUsage();
  const model = ctx.model;
  const subagentState = reconstructSubagentState(entries);
  const capabilityOrder = ["subagents"];
  const capabilityLabels = [...capabilities.snapshot().capabilities]
    .filter((capability) => capability.serviceEnabled)
    .sort((left, right) => {
      const leftIndex = capabilityOrder.indexOf(left.id);
      const rightIndex = capabilityOrder.indexOf(right.id);
      return (leftIndex < 0 ? capabilityOrder.length : leftIndex)
        - (rightIndex < 0 ? capabilityOrder.length : rightIndex);
    })
    .map((capability) => {
      if (capability.id === "subagents") return subagentState.agentName ?? "orchestrator";
      return capability.label;
    });
  return {
    cwd: ctx.cwd,
    capabilities: capabilityLabels,
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
  };
}

function billedUsage(entry: SessionEntry): Usage | undefined {
  if (entry.type === "message") {
    const message = entry.message as typeof entry.message & { usage?: Usage };
    return message.role === "assistant" || message.role === "toolResult" ? message.usage : undefined;
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return (entry as typeof entry & { usage?: Usage }).usage;
  }
  return undefined;
}
