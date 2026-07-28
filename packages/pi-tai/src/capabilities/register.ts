import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CAPABILITY_STATE_ENTRY, formatCapabilitySnapshot } from "./domain.ts";
import { SessionCapabilityController } from "./controller.ts";

export function registerCapabilityController(
  pi: ExtensionAPI,
  controller: SessionCapabilityController,
): void {
  controller.bindTools({
    getActiveTools: () => pi.getActiveTools(),
    setActiveTools: (names) => pi.setActiveTools(names),
  });
  controller.bindPersistence((enabled) => {
    pi.appendEntry(CAPABILITY_STATE_ENTRY, { enabled: [...enabled] });
  });

  pi.on("session_start", (event, ctx) => {
    controller.reconstruct(
      ctx.sessionManager.getEntries(),
      event.reason === "new" || event.reason === "fork",
    );
  });

  pi.on("before_agent_start", (event) => {
    const layers = controller.promptLayers();
    if (layers.length === 0) return;
    return { systemPrompt: [event.systemPrompt, ...layers].join("\n\n") };
  });

  pi.registerCommand("capabilities", {
    description: "List Pi-Tai session capabilities",
    handler: async (_args, ctx) => {
      for (const capability of controller.snapshot().capabilities) {
        await controller.probe(capability.id);
      }
      ctx.ui.notify(formatCapabilitySnapshot(controller.snapshot()), "info");
    },
  });
}
