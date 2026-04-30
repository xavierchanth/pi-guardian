import type { ToolPolicies } from "./access-policy";

export type GuardianModeId = "auto" | "plan" | "edit" | "read";
export type GuardianReviewMode = "ask" | "block";

export type GuardianToolName = "bash" | "read" | "write" | "edit";

export interface GuardianModeDefinition {
	id: GuardianModeId;
	label: string;
	description: string;
	order: number;
	registeredTools: GuardianToolName[];
	systemPrompt?: string;
	policies: ToolPolicies;
}

export interface GuardianModeRegistry {
	get(id: GuardianModeId): GuardianModeDefinition;
	list(): GuardianModeDefinition[];
	has(id: string): id is GuardianModeId;
}

export const MODE_ORDER: GuardianModeId[] = ["auto", "plan", "edit", "read"];

export const MODE_CAPABILITY_RANK: Record<GuardianModeId, number> = {
	read: 0,
	plan: 1,
	edit: 2,
	auto: 3,
};

export function createModeRegistry(modes: GuardianModeDefinition[]): GuardianModeRegistry {
	const byId = new Map<GuardianModeId, GuardianModeDefinition>();

	for (const mode of modes) {
		if (byId.has(mode.id)) {
			throw new Error(`Duplicate guardian mode registration: ${mode.id}`);
		}
		byId.set(mode.id, mode);
	}

	for (const modeId of MODE_ORDER) {
		if (!byId.has(modeId)) {
			throw new Error(`Missing guardian mode registration: ${modeId}`);
		}
	}

	const list = [...byId.values()].sort((a, b) => a.order - b.order);

	return {
		get(id) {
			const mode = byId.get(id);
			if (!mode) throw new Error(`Unknown guardian mode: ${id}`);
			return mode;
		},
		list() {
			return list;
		},
		has(id: string): id is GuardianModeId {
			return byId.has(id as GuardianModeId);
		},
	};
}
