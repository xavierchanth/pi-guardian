import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionPolicyReader } from "../config/register.ts";

export function registerAutoCompaction(
  pi: ExtensionAPI,
  config: SessionPolicyReader,
): void {
  let compactionInProgress = false;

  pi.on("agent_settled", async (_event, ctx) => {
    const policy = config.sessionPolicy().compaction;
    if (!policy.enabled || compactionInProgress || !ctx.isIdle()) return;

    const usage = ctx.getContextUsage();
    if (usage?.percent === null || usage?.percent === undefined) return;
    if (usage.percent < policy.thresholdPercent) return;

    compactionInProgress = true;
    try {
      await compact(ctx);
    } finally {
      compactionInProgress = false;
    }
  });
}

function compact(ctx: ExtensionContext): Promise<void> {
  return new Promise((resolve) => {
    ctx.compact({
      onComplete: () => resolve(),
      onError: (error) => {
        ctx.ui.notify(`Automatic compaction failed: ${error.message}`, "warning");
        resolve();
      },
    });
  });
}
