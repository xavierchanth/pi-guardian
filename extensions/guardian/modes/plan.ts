import type { GuardianModeHandlerFactoryDeps, GuardianRegisteredMode } from "../core/guardian-types";

export function createPlanMode(deps: GuardianModeHandlerFactoryDeps): GuardianRegisteredMode {
	return {
		id: "plan",
		label: "Plan",
		description: "Planning-focused access with Markdown-only file modifications.",
		order: 1,
		registeredTools: ["bash", "read", "write", "edit"],
		systemPrompt: "Focus on planning, not implementation. Prefer outlining steps over making code changes.",
		handlers: {
			bash: (input, context) => deps.onBash("plan", input, context),
			read: (input, context) => deps.onRead("plan", input, context),
		},
	};
}
