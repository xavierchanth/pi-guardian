export type GuardianModeId = "auto" | "plan" | "edit" | "read";
export type GuardianReviewMode = "ask" | "block";

export type GuardianToolName = "bash" | "read" | "write" | "edit";

export interface GuardianToolHandlerContext<State = unknown, Ctx = unknown, Pi = unknown> {
	state: State;
	ctx: Ctx;
	pi: Pi;
}

export type GuardianToolHandler<State = unknown, Input = unknown, Ctx = unknown, Pi = unknown, Result = unknown> = (
	input: Input,
	context: GuardianToolHandlerContext<State, Ctx, Pi>,
) => Promise<Result> | Result;

export interface GuardianModeDefinition<State = unknown, Ctx = unknown, Pi = unknown, Result = unknown> {
	id: GuardianModeId;
	label: string;
	description: string;
	order: number;
	registeredTools: GuardianToolName[];
	systemPrompt?: string;
	handlers: Partial<{
		bash: GuardianToolHandler<State, string, Ctx, Pi, Result>;
		read: GuardianToolHandler<State, string, Ctx, Pi, Result>;
		write: GuardianToolHandler<State, string, Ctx, Pi, Result>;
		edit: GuardianToolHandler<State, string, Ctx, Pi, Result>;
	}>;
}

export interface GuardianModeRegistry<State = unknown, Ctx = unknown, Pi = unknown, Result = unknown> {
	get(id: GuardianModeId): GuardianModeDefinition<State, Ctx, Pi, Result>;
	list(): GuardianModeDefinition<State, Ctx, Pi, Result>[];
	has(id: string): id is GuardianModeId;
}

export const MODE_ORDER: GuardianModeId[] = ["auto", "plan", "edit", "read"];

export const MODE_CAPABILITY_RANK: Record<GuardianModeId, number> = {
	read: 0,
	plan: 1,
	edit: 2,
	auto: 3,
};

export function createModeRegistry<State = unknown, Ctx = unknown, Pi = unknown, Result = unknown>(
	modes: GuardianModeDefinition<State, Ctx, Pi, Result>[],
): GuardianModeRegistry<State, Ctx, Pi, Result> {
	const byId = new Map<GuardianModeId, GuardianModeDefinition<State, Ctx, Pi, Result>>();

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
			if (!mode) {
				throw new Error(`Unknown guardian mode: ${id}`);
			}
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
