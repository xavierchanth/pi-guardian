import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

const CONTINUE_MESSAGE_TYPE = "pi-tai-continue";
const CONTINUE_MESSAGE = "Continue what you were doing.";

function participatesInConversation(entry: SessionEntry): boolean {
  return (
    entry.type === "message" ||
    entry.type === "custom_message" ||
    entry.type === "compaction" ||
    entry.type === "branch_summary"
  );
}

export function registerContinueCommand(pi: ExtensionAPI): void {
  pi.registerCommand("continue", {
    description: "Continue the agent's previous work",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /continue", "warning");
        return;
      }

      if (!ctx.isIdle()) {
        ctx.ui.notify("The agent is still working.", "warning");
        return;
      }

      if (!ctx.sessionManager.getBranch().some(participatesInConversation)) {
        ctx.ui.notify("There is no previous work to continue.", "info");
        return;
      }

      pi.sendMessage(
        {
          customType: CONTINUE_MESSAGE_TYPE,
          content: CONTINUE_MESSAGE,
          display: false,
        },
        { triggerTurn: true },
      );
      await ctx.waitForIdle();
    },
  });
}
