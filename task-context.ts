import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type TaskItem = {
	title: string;
	completed: boolean;
};

type TaskContextState = {
	goal?: string;
	tasks: TaskItem[];
	uiVisible: boolean;
};

type PersistedTaskContext = {
	version: 1;
	state: TaskContextState;
};

const TASK_CONTEXT_TYPE = "task-context-state";
const TASK_CONTEXT_BLOCK_RE = /```task-context\s*([\s\S]*?)```/gi;

function createInitialState(): TaskContextState {
	return {
		goal: undefined,
		tasks: [],
		uiVisible: true,
	};
}

function cloneState(state: TaskContextState): TaskContextState {
	return {
		goal: state.goal,
		uiVisible: state.uiVisible,
		tasks: state.tasks.map((task) => ({ ...task })),
	};
}

function normalizeState(input: unknown): TaskContextState {
	const fallback = createInitialState();
	if (!input || typeof input !== "object") return fallback;

	const raw = input as Record<string, unknown>;
	const goal = typeof raw.goal === "string" && raw.goal.trim() ? raw.goal.trim() : undefined;
	const uiVisible = raw.uiVisible !== false;
	const tasks = Array.isArray(raw.tasks)
		? raw.tasks
				.filter((task): task is Record<string, unknown> => Boolean(task) && typeof task === "object")
				.map((task) => ({
					title: typeof task.title === "string" ? task.title.trim() : "",
					completed: task.completed === true,
				}))
				.filter((task) => task.title.length > 0)
		: [];

	return { goal, tasks, uiVisible };
}

function loadStateFromSession(ctx: any): TaskContextState {
	const entries = ctx?.sessionManager?.getEntries?.();
	if (!Array.isArray(entries)) {
		return createInitialState();
	}

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || entry.type !== "custom" || entry.customType !== TASK_CONTEXT_TYPE) {
			continue;
		}

		const data = entry.data as PersistedTaskContext | undefined;
		if (!data || data.version !== 1) {
			continue;
		}

		return normalizeState(data.state);
	}

	return createInitialState();
}

function persistState(state: TaskContextState, pi: ExtensionAPI): void {
	pi.appendEntry<PersistedTaskContext>(TASK_CONTEXT_TYPE, {
		version: 1,
		state: cloneState(state),
	});
}

function summarizeTask(task: TaskItem, index: number): string {
	return `${index + 1}.${task.completed ? "x" : " "} ${task.title}`;
}

function truncate(text: string, max = 120): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function buildStatusText(state: TaskContextState): string | undefined {
	if (!state.uiVisible) return undefined;

	const total = state.tasks.length;
	const completed = state.tasks.filter((task) => task.completed).length;
	const nextOpen = state.tasks.find((task) => !task.completed);
	const parts: string[] = [];

	if (state.goal) {
		parts.push(`Goal: ${truncate(state.goal, 48)}`);
	}

	parts.push(`Tasks ${completed}/${total}`);

	if (nextOpen) {
		parts.push(`Next: ${truncate(nextOpen.title, 36)}`);
	}

	return parts.join(" | ");
}

function refreshStatus(state: TaskContextState, ctx: any): void {
	ctx.ui?.setStatus?.("tasks", buildStatusText(state));
}

function formatTaskList(state: TaskContextState): string {
	const lines: string[] = [];

	lines.push(`Goal: ${state.goal ?? "None"}`);
	lines.push(`UI: ${state.uiVisible ? "shown" : "hidden"}`);

	if (state.tasks.length === 0) {
		lines.push("Tasks: none");
		return lines.join("\n");
	}

	lines.push("Tasks:");
	for (let i = 0; i < state.tasks.length; i++) {
		const task = state.tasks[i];
		lines.push(`  ${summarizeTask(task, i)}`);
	}

	return lines.join("\n");
}

function parsePositiveIndex(input: string, max: number): number | undefined {
	const parsed = Number.parseInt(input, 10);
	if (!Number.isFinite(parsed) || parsed < 1 || parsed > max) {
		return undefined;
	}
	return parsed - 1;
}

function extractAssistantText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}

	return content
		.filter((block): block is { type?: string; text?: string } => Boolean(block) && typeof block === "object")
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n");
}

function parseTaskContextBlock(text: string): TaskContextState | undefined {
	let match: RegExpExecArray | null = null;
	let lastJson = "";

	TASK_CONTEXT_BLOCK_RE.lastIndex = 0;
	while (true) {
		match = TASK_CONTEXT_BLOCK_RE.exec(text);
		if (!match) break;
		lastJson = match[1]?.trim() ?? "";
	}

	if (!lastJson) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(lastJson) as {
			goal?: unknown;
			tasks?: unknown;
			uiVisible?: unknown;
		};
		return normalizeState(parsed);
	} catch {
		return undefined;
	}
}

function getTaskContextInstructions(state: TaskContextState): string {
	const snapshot = JSON.stringify(
		{
			goal: state.goal,
			tasks: state.tasks,
			uiVisible: state.uiVisible,
		},
		null,
		2,
	);

	return `
Task tracker:
- Keep one north-star goal and a concise task list for the current work.
- When the plan changes materially, or when you complete/add/rewrite tasks, append a fenced \`task-context\` JSON block to your assistant message.
- Emit the block only when you want to update tracker state.
- The JSON block replaces the full tracker state, so include the full current goal and all tasks.

Current tracker state:
\`\`\`task-context
${snapshot}
\`\`\`
`.trim();
}

async function handleGoalCommand(state: TaskContextState, args: string, ctx: any, pi: ExtensionAPI): Promise<void> {
	const value = args.trim();

	if (!value) {
		ctx.ui.notify(formatTaskList(state), "info");
		return;
	}

	if (value.toLowerCase() === "clear") {
		state.goal = undefined;
		persistState(state, pi);
		refreshStatus(state, ctx);
		ctx.ui.notify("Goal cleared", "info");
		return;
	}

	state.goal = value;
	persistState(state, pi);
	refreshStatus(state, ctx);
	ctx.ui.notify(`Goal set: ${value}`, "info");
}

async function handleTasksCommand(state: TaskContextState, args: string, ctx: any, pi: ExtensionAPI): Promise<void> {
	const trimmed = args.trim();
	if (!trimmed || trimmed === "list" || trimmed === "show") {
		ctx.ui.notify(formatTaskList(state), "info");
		return;
	}

	const [actionRaw, ...restParts] = trimmed.split(/\s+/);
	const action = actionRaw.toLowerCase();
	const rest = restParts.join(" ").trim();

	if (action === "add") {
		if (!rest) {
			ctx.ui.notify("Usage: /tasks add <title>", "error");
			return;
		}
		state.tasks.push({ title: rest, completed: false });
		persistState(state, pi);
		refreshStatus(state, ctx);
		ctx.ui.notify(`Task added: ${rest}`, "info");
		return;
	}

	if (action === "clear" || action === "reset") {
		state.tasks = [];
		if (action === "reset") {
			state.goal = undefined;
		}
		persistState(state, pi);
		refreshStatus(state, ctx);
		ctx.ui.notify(action === "reset" ? "Goal and tasks reset" : "Tasks cleared", "info");
		return;
	}

	if (action === "hide") {
		state.uiVisible = false;
		persistState(state, pi);
		refreshStatus(state, ctx);
		ctx.ui.notify("Task UI hidden", "info");
		return;
	}

	if (action === "unhide" || action === "show-ui") {
		state.uiVisible = true;
		persistState(state, pi);
		refreshStatus(state, ctx);
		ctx.ui.notify("Task UI shown", "info");
		return;
	}

	const [indexToken, ...extraParts] = rest.split(/\s+/);
	const taskIndex = parsePositiveIndex(indexToken ?? "", state.tasks.length);
	if (taskIndex === undefined) {
		ctx.ui.notify("Task index is missing or out of range", "error");
		return;
	}

	if (action === "done") {
		state.tasks[taskIndex].completed = true;
		persistState(state, pi);
		refreshStatus(state, ctx);
		ctx.ui.notify(`Task ${taskIndex + 1} marked complete`, "info");
		return;
	}

	if (action === "undo") {
		state.tasks[taskIndex].completed = false;
		persistState(state, pi);
		refreshStatus(state, ctx);
		ctx.ui.notify(`Task ${taskIndex + 1} marked incomplete`, "info");
		return;
	}

	if (action === "toggle") {
		state.tasks[taskIndex].completed = !state.tasks[taskIndex].completed;
		persistState(state, pi);
		refreshStatus(state, ctx);
		ctx.ui.notify(`Task ${taskIndex + 1} toggled`, "info");
		return;
	}

	if (action === "remove") {
		const [removed] = state.tasks.splice(taskIndex, 1);
		persistState(state, pi);
		refreshStatus(state, ctx);
		ctx.ui.notify(`Task removed: ${removed?.title ?? taskIndex + 1}`, "info");
		return;
	}

	if (action === "edit") {
		const newTitle = extraParts.join(" ").trim();
		if (!newTitle) {
			ctx.ui.notify("Usage: /tasks edit <index> <title>", "error");
			return;
		}
		state.tasks[taskIndex].title = newTitle;
		persistState(state, pi);
		refreshStatus(state, ctx);
		ctx.ui.notify(`Task ${taskIndex + 1} updated`, "info");
		return;
	}

	if (action === "move") {
		const destinationIndex = parsePositiveIndex(extraParts[0] ?? "", state.tasks.length);
		if (destinationIndex === undefined) {
			ctx.ui.notify("Usage: /tasks move <index> <destination>", "error");
			return;
		}
		const [task] = state.tasks.splice(taskIndex, 1);
		state.tasks.splice(destinationIndex, 0, task);
		persistState(state, pi);
		refreshStatus(state, ctx);
		ctx.ui.notify(`Task ${taskIndex + 1} moved to ${destinationIndex + 1}`, "info");
		return;
	}

	ctx.ui.notify(
		"Usage: /tasks [list|add|done|undo|toggle|edit|move|remove|clear|reset|hide|show-ui]",
		"error",
	);
}

async function handleTasksToggleCommand(state: TaskContextState, ctx: any, pi: ExtensionAPI): Promise<void> {
	state.uiVisible = !state.uiVisible;
	persistState(state, pi);
	refreshStatus(state, ctx);
	ctx.ui.notify(state.uiVisible ? "Task UI shown" : "Task UI hidden", "info");
}

export default function (pi: ExtensionAPI) {
	const state = createInitialState();

	pi.registerCommand("goal", {
		description: "View, set, or clear the current goal",
		handler: (args, ctx) => handleGoalCommand(state, args, ctx, pi),
	});

	pi.registerCommand("tasks", {
		description: "Manage the current task list",
		handler: (args, ctx) => handleTasksCommand(state, args, ctx, pi),
	});

	pi.registerCommand("tasks:toggle", {
		description: "Hide or show the task status UI",
		handler: (_args, ctx) => handleTasksToggleCommand(state, ctx, pi),
	});

	pi.on("session_start", async (_event, ctx) => {
		const loaded = loadStateFromSession(ctx);
		state.goal = loaded.goal;
		state.tasks = loaded.tasks;
		state.uiVisible = loaded.uiVisible;
		refreshStatus(state, ctx);
	});

	pi.on("before_agent_start", async () => {
		return {
			systemPrompt: getTaskContextInstructions(state),
		};
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") {
			return;
		}

		const text = extractAssistantText(event.message.content);
		const nextState = parseTaskContextBlock(text);
		if (!nextState) {
			return;
		}

		state.goal = nextState.goal;
		state.tasks = nextState.tasks;
		state.uiVisible = nextState.uiVisible;
		persistState(state, pi);
		refreshStatus(state, ctx);
	});
}
