import type { GuardianModeDefinition } from "../core/mode-framework.ts";

export const autoMode: GuardianModeDefinition = {
	id: "auto",
	label: "Auto",
	description: "Automatically review actions with a guardian agent.",
	order: 0,
	registeredTools: ["bash", "read", "write", "edit"],
	policies: {
		bash: {
			kind: "bash",
			maxCommandLevel: "auto",
			allowDangerous: "review-in-auto",
			highRisk: "review-in-auto",
		},
		read: {
			kind: "read",
			sensitiveAccess: "review-in-auto",
		},
		write: {
			kind: "write",
			allow: true,
			sensitiveAccess: "review-in-auto",
		},
		edit: {
			kind: "write",
			allow: true,
			sensitiveAccess: "review-in-auto",
		},
	},
};
