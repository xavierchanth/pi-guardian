import type { GuardianModeHandlerFactoryDeps, GuardianRegisteredMode } from "../core/guardian-types";

export function createAutoMode(deps: GuardianModeHandlerFactoryDeps): GuardianRegisteredMode {
	return {
		id: "auto",
		label: "Auto",
		description: "Automatically review actions with a guardian agent.",
		order: 0,
		registeredTools: ["bash", "read", "write", "edit"],
		handlers: {
			bash: (input, context) => deps.onBash("auto", input, context),
			read: (input, context) => deps.onRead("auto", input, context),
			write: (input, context) => deps.onWrite("auto", "write", input, context),
			edit: (input, context) => deps.onWrite("auto", "edit", input, context),
		},
	};
}
