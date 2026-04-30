import type { GuardianModeDefinition } from "../core/mode-framework";

export const editMode: GuardianModeDefinition = {
	id: "edit",
	label: "Edit",
	description: "Read and edit files within the current workspace.",
	order: 2,
	registeredTools: ["bash", "read", "write", "edit"],
	policies: {
		bash: {
			kind: "bash",
			maxCommandLevel: "edit",
			allowDangerous: "prompt",
			highRisk: "allow",
		},
		read: {
			kind: "read",
			sensitiveAccess: "prompt-upgrade-auto",
		},
		write: {
			kind: "write",
			allow: true,
			sensitiveAccess: "prompt-upgrade-auto",
		},
		edit: {
			kind: "write",
			allow: true,
			sensitiveAccess: "prompt-upgrade-auto",
		},
	},
};
