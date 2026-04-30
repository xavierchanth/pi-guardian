import type { GuardianModeHandlerFactoryDeps, GuardianRegisteredMode } from "../core/guardian-types";

export function createEditMode(deps: GuardianModeHandlerFactoryDeps): GuardianRegisteredMode {
	return {
		id: "edit",
		label: "Edit",
		description: "Read and edit files within the current workspace.",
		order: 2,
		registeredTools: ["bash", "read", "write", "edit"],
		handlers: {
			bash: (input, context) => deps.onBash("edit", input, context),
			read: (input, context) => deps.onRead("edit", input, context),
			write: (input, context) => deps.onWrite("edit", "write", input, context),
			edit: (input, context) => deps.onWrite("edit", "edit", input, context),
		},
	};
}
