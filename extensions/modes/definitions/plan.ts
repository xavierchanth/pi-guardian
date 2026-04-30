import type { GuardianModeDefinition } from "../core/mode-framework";

export const planMode: GuardianModeDefinition = {
	id: "plan",
	label: "Plan",
	description: "Planning-focused access with Markdown-only file modifications.",
	order: 1,
	registeredTools: ["bash", "read", "write", "edit"],
	systemPrompt: "Focus on planning, not implementation. Prefer outlining steps over making code changes.",
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
		write: {
			kind: "write",
			allow: true,
			allowedExtensions: [".md", ".mdx"],
			sensitiveAccess: "prompt-upgrade-auto",
		},
		edit: {
			kind: "write",
			allow: true,
			allowedExtensions: [".md", ".mdx"],
			sensitiveAccess: "prompt-upgrade-auto",
		},
	},
};
