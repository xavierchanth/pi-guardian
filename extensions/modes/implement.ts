import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PermissionState } from "./core/guardian-types";
import { setModeSessionOnly } from "./core/runtime";

export function registerImplementCommand(pi: ExtensionAPI, state: PermissionState): void {
	pi.registerCommand("implement", {
		description: "Switch from plan mode to auto mode and start implementation",
		handler: async (_args, ctx) => {
			if (state.currentMode !== "plan") {
				ctx.ui.notify("/implement is only available in plan mode.", "error");
				return;
			}

			setModeSessionOnly(state, "auto", ctx);
			ctx.ui.notify("Mode: Auto (session only)", "info");
			pi.sendUserMessage("Implement plan");
		},
	});
}
