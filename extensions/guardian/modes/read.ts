import type { GuardianModeHandlerFactoryDeps, GuardianRegisteredMode } from "../core/guardian-types";

export function createReadMode(deps: GuardianModeHandlerFactoryDeps): GuardianRegisteredMode {
	return {
		id: "read",
		label: "Read",
		description: "Read only access to the current workspace.",
		order: 3,
		registeredTools: ["bash", "read"],
		handlers: {
			bash: (input, context) => deps.onBash("read", input, context),
			read: (input, context) => deps.onRead("read", input, context),
		},
	};
}
