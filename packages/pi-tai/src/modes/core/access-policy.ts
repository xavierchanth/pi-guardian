import type { GuardianModeId, GuardianToolName } from "./mode-framework";

export type ReviewRequirement = "none" | "auto-review";
export type SensitiveAccessBehavior = "allow" | "deny" | "prompt-upgrade-auto" | "review-in-auto";

export interface BashToolPolicy {
	kind: "bash";
	maxCommandLevel: "read" | "edit" | "auto";
	allowDangerous: "prompt" | "review-in-auto";
	highRisk: "allow" | "review-in-auto";
}

export interface ReadToolPolicy {
	kind: "read";
	sensitiveAccess: SensitiveAccessBehavior;
}

export interface WriteToolPolicy {
	kind: "write";
	allow: boolean;
	allowedExtensions?: string[];
	sensitiveAccess: SensitiveAccessBehavior;
}

export type ToolPolicy = BashToolPolicy | ReadToolPolicy | WriteToolPolicy;

export type ToolPolicies = Partial<Record<GuardianToolName, ToolPolicy>>;

export interface ToolAccessDecision {
	decision: "allow" | "deny" | "prompt-upgrade" | "review";
	reason?: string;
	targetMode?: GuardianModeId;
	reviewReason?: string;
}
