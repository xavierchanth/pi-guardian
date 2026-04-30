import type { GuardianModeDefinition } from "../core/mode-framework";

export const readMode: GuardianModeDefinition = {
	id: "read",
	label: "Read",
	description: "Read only access to the current workspace.",
	order: 3,
	registeredTools: ["bash", "read"],
	policies: {
		bash: {
			kind: "bash",
			maxCommandLevel: "read",
			allowDangerous: "prompt",
			highRisk: "allow",
		},
		read: {
			kind: "read",
			sensitiveAccess: "prompt-upgrade-auto",
		},
	},
};
