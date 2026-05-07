/**
 * Guardian mode extension for pi-coding-agent
 *
 * Implements a registry-backed mode system with auto-review support.
 *
 * Interactive mode:
 *   Use `/mode` to view or change the active mode.
 *   Use `/review-mode` to switch between ask vs block review behavior.
 *
 * Print mode (pi -p):
 *   Set PI_PERMISSION_LEVEL env var: PI_PERMISSION_LEVEL=auto pi -p "task"
 *   Operations beyond the active mode will exit with a helpful error message.
 *
 * Modes:
 *   auto - Development operations with auto-review
 *   plan - Planning-focused access with Markdown-only file modifications
 *   edit - Read and edit files within the workspace
 *   read - Read-only workspace access
 */

import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { complete, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { evaluateBashAccess, evaluateReadAccess, evaluateWriteAccess, inspectFileAccessTarget as inspectSharedFileAccessTarget } from "./evaluate-access";
import { createModeRegistry, type GuardianModeDefinition, type GuardianModeRegistry } from "./mode-framework";
import type { PermissionState, ToolHandlerResult } from "./guardian-types";
import {
	type PermissionLevel,
	type PermissionMode,
	LEVELS,
	LEVEL_INFO,
	PERMISSION_MODES,
	PERMISSION_MODE_INFO,
	loadGlobalPermission,
	saveGlobalPermission,
	loadGlobalPermissionMode,
	saveGlobalPermissionMode,
	loadPermissionConfig,
	savePermissionConfig,
	invalidateConfigCache,
	loadAutoReviewModels,
	type Classification,
	classifyCommand,
} from "./permission-core";

// Re-export types and constants needed by the hook
export {
	type PermissionLevel,
	type PermissionMode,
	LEVELS,
	LEVEL_INFO,
	PERMISSION_MODES,
	PERMISSION_MODE_INFO,
};

let modeRegistry: GuardianModeRegistry | undefined;

function getModeRegistry(): GuardianModeRegistry {
	if (!modeRegistry) {
		throw new Error("Guardian mode registry has not been initialized.");
	}
	return modeRegistry;
}

// ============================================================================
// SOUND NOTIFICATION
// ============================================================================

function playPermissionSound(): void {
	const isMac = process.platform === "darwin";

	if (isMac) {
		exec("afplay /System/Library/Sounds/Funk.aiff 2>/dev/null", (err) => {
			if (err) process.stdout.write("\x07");
		});
	} else {
		process.stdout.write("\x07");
	}
}

// ============================================================================
// STATUS TEXT
// ============================================================================

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const WHITE = "\x1b[37m";

const LEVEL_COLORS: Record<PermissionLevel, string> = {
	auto: CYAN,
	plan: GREEN,
	edit: YELLOW,
	read: RED,
};

function getStatusText(level: PermissionLevel): string {
	const info = LEVEL_INFO[level];
	const color = LEVEL_COLORS[level];
	return `${BOLD}${color}${info.label}${RESET} ${WHITE}|${RESET}`;
}

// ============================================================================
// MODE DETECTION
// ============================================================================

function getPiModeFromArgv(argv: string[] = process.argv): string | undefined {
	// Support both: --mode rpc and --mode=rpc
	const eq = argv.find((a) => a.startsWith("--mode="));
	if (eq) return eq.slice("--mode=".length);

	const idx = argv.indexOf("--mode");
	if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];

	return undefined;
}

function hasInteractiveUI(ctx: any): boolean {
	if (!ctx?.hasUI) return false;

	// RPC mode supports extension UI dialogs over the extension_ui_request /
	// extension_ui_response sub-protocol. Only JSON/print should suppress prompts.
	const mode = getPiModeFromArgv()?.toLowerCase();
	if (mode === "json" || mode === "print") return false;

	return true;
}

function isQuietMode(ctx: any): boolean {
	if (ctx?.quiet || ctx?.isQuiet) return true;
	if (ctx?.ui?.quiet || ctx?.ui?.isQuiet) return true;
	if (ctx?.settings?.quietStartup || ctx?.settings?.quiet) return true;

	const envQuiet = process.env.PI_QUIET?.toLowerCase();
	if (envQuiet && ["1", "true", "yes"].includes(envQuiet)) return true;

	if (process.argv.includes("--quiet") || process.argv.includes("-q")) return true;

	return isQuietStartupFromSettings();
}

function isQuietStartupFromSettings(): boolean {
	const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
	try {
		const raw = fs.readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(raw) as { quietStartup?: boolean };
		return settings.quietStartup === true;
	} catch {
		return false;
	}
}

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

export function createInitialState(): PermissionState {
	return {
		currentMode: "read",
		isSessionOnly: false,
		reviewMode: "ask",
		isReviewModeSessionOnly: false,
	};
}

function setCurrentMode(state: PermissionState, mode: PermissionLevel, saveGlobally: boolean, ctx: any): void {
	state.currentMode = mode;
	state.isSessionOnly = !saveGlobally;
	if (saveGlobally) {
		saveGlobalPermission(mode);
	}
	if (ctx.ui?.setStatus) {
		ctx.ui.setStatus("authority", getStatusText(mode));
	}
}

function modeAllowsRequiredLevel(mode: PermissionLevel, requiredLevel: "read" | "edit" | "auto"): boolean {
	switch (requiredLevel) {
		case "read":
			return true;
		case "edit":
			return mode === "edit" || mode === "auto";
		case "auto":
			return mode === "auto";
	}
}

function isMarkdownPath(filePath: string): boolean {
	return /\.mdx?$/i.test(filePath);
}

function modeSupportsFileWrites(mode: PermissionLevel, filePath: string): boolean {
	if (mode === "auto" || mode === "edit") return true;
	if (mode === "plan") return isMarkdownPath(filePath);
	return false;
}

// ============================================================================
// FILE PATH REVIEW
// ============================================================================

const SENSITIVE_PATH_SEGMENTS = new Set([
	".aws",
	".azure",
	".git",
	".gnupg",
	".kube",
	".ssh",
	"credentials",
	"secrets",
]);

const SENSITIVE_FILE_NAMES = new Set([
	".envrc",
	".netrc",
	".npmrc",
	".pypirc",
	"auth.json",
	"credentials",
	"credentials.json",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
	"id_rsa",
	"service-account.json",
	"serviceaccount.json",
]);

const SENSITIVE_FILE_EXTENSIONS = new Set([
	".age",
	".asc",
	".cer",
	".crt",
	".csr",
	".der",
	".gpg",
	".jks",
	".kdbx",
	".key",
	".keystore",
	".p12",
	".p8",
	".pem",
	".pfx",
	".pgp",
]);

const SENSITIVE_BASENAME_PATTERN = /(^|[._-])(api[_-]?key|credential|credentials|passwd|password|private[_-]?key|secret|secrets)([._-]|$)/i;

function getSessionCwd(ctx: any): string {
	if (typeof ctx?.cwd === "string" && ctx.cwd.length > 0) {
		return path.resolve(ctx.cwd);
	}
	return process.cwd();
}

function resolveTargetPath(filePath: string, cwd: string): string {
	if (path.isAbsolute(filePath)) {
		return path.normalize(filePath);
	}
	return path.normalize(path.resolve(cwd, filePath));
}

function isPathWithinDirectory(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function getSensitivePathReason(filePath: string): string | undefined {
	const normalized = path.normalize(filePath);
	const lowered = normalized.toLowerCase();
	const basename = path.basename(lowered);
	const extension = path.extname(basename);
	const segments = lowered.split(/[\\/]+/).filter(Boolean);

	if (segments.some((segment) => SENSITIVE_PATH_SEGMENTS.has(segment))) {
		return "targets a sensitive directory such as .git, .ssh, or a credentials/secrets path";
	}

	if (basename === ".env" || basename.startsWith(".env.")) {
		return "matches an environment file pattern (.env*)";
	}

	if (SENSITIVE_FILE_NAMES.has(basename)) {
		return "matches a sensitive credentials or private-key filename";
	}

	if (SENSITIVE_FILE_EXTENSIONS.has(extension)) {
		return `uses a sensitive key or certificate extension (${extension})`;
	}

	if (SENSITIVE_BASENAME_PATTERN.test(basename)) {
		return "matches a sensitive secret or credential filename pattern";
	}

	return undefined;
}

interface FileAccessTarget {
	cwd: string;
	resolvedPath: string;
	withinCwd: boolean;
	reviewReason?: string;
}

function inspectFileAccessTarget(filePath: string, ctx: any): FileAccessTarget {
	const cwd = getSessionCwd(ctx);
	const resolvedPath = resolveTargetPath(filePath, cwd);
	const withinCwd = isPathWithinDirectory(cwd, resolvedPath);
	const sensitiveReason = getSensitivePathReason(resolvedPath);
	const reviewReason = !withinCwd
		? `target is outside the current working directory (${cwd})`
		: sensitiveReason;

	return {
		cwd,
		resolvedPath,
		withinCwd,
		reviewReason,
	};
}

function setReviewMode(state: PermissionState, mode: PermissionMode, saveGlobally: boolean, _ctx: any): void {
	state.reviewMode = mode;
	state.isReviewModeSessionOnly = !saveGlobally;
	if (saveGlobally) {
		saveGlobalPermissionMode(mode);
	}
}

// ============================================================================
// REVIEW CONTEXT
// ============================================================================

function extractMessageText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}

	if (!Array.isArray(content)) {
		return "";
	}

	return content
		.filter((block): block is { type?: string; text?: string } => Boolean(block) && typeof block === "object")
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text!.trim())
		.filter(Boolean)
		.join("\n");
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateForReview(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function getTrackedTaskContext(ctx: any): string | undefined {
	const entries = ctx?.sessionManager?.getEntries?.();
	if (!Array.isArray(entries)) {
		return undefined;
	}

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || entry.type !== "custom" || entry.customType !== "task-context-state") {
			continue;
		}

		const state = (entry.data as { state?: { goal?: unknown; tasks?: unknown } } | undefined)?.state;
		if (!state || typeof state !== "object") {
			continue;
		}

		const goal = typeof state.goal === "string" && state.goal.trim() ? state.goal.trim() : undefined;
		const tasks = Array.isArray(state.tasks)
			? state.tasks
					.filter((task): task is { title?: unknown; completed?: unknown } => Boolean(task) && typeof task === "object")
					.map((task, index) => {
						const title = typeof task.title === "string" ? task.title.trim() : "";
						if (!title) return undefined;
						const marker = task.completed === true ? "[x]" : "[ ]";
						return `${index + 1}. ${marker} ${title}`;
					})
					.filter((task): task is string => Boolean(task))
			: [];

		if (!goal && tasks.length === 0) {
			return undefined;
		}

		const lines: string[] = [];
		if (goal) {
			lines.push(`Tracked goal: ${truncateForReview(goal, 240)}`);
		}
		if (tasks.length > 0) {
			lines.push("Tracked tasks:");
			lines.push(...tasks.map((task) => truncateForReview(task, 240)));
		}

		return lines.join("\n");
	}

	return undefined;
}

function getCurrentTaskContext(ctx: any): string {
	const tracked = getTrackedTaskContext(ctx);
	const branch = ctx?.sessionManager?.getBranch?.();
	if (!Array.isArray(branch) || branch.length === 0) {
		return tracked ?? "Unavailable.";
	}

	const recentMessages: string[] = [];

	for (let i = branch.length - 1; i >= 0 && recentMessages.length < 4; i--) {
		const entry = branch[i];
		if (!entry || entry.type !== "message") {
			continue;
		}

		const message = entry.message;
		if (!message || typeof message !== "object" || !("role" in message)) {
			continue;
		}

		if (message.role !== "user" && message.role !== "assistant") {
			continue;
		}

		const text = singleLine(extractMessageText(message.content));
		if (!text) {
			continue;
		}

		const label = message.role === "user" ? "User" : "Assistant";
		recentMessages.push(`${label}: ${truncateForReview(text, 280)}`);
	}

	if (recentMessages.length === 0) {
		return tracked ?? "Unavailable.";
	}

	const parts = tracked ? [tracked, recentMessages.reverse().join("\n")] : [recentMessages.reverse().join("\n")];
	return truncateForReview(parts.join("\n"), 1200);
}

// ============================================================================
// AUTO-REVIEW
// ============================================================================

interface ModelRegistryLike {
	find(provider: string, modelId: string): Model<Api> | undefined;
	getApiKeyAndHeaders(
		model: Model<Api>,
	): Promise<{ ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }>;
}

function getAssistantText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

async function callAutoReviewModel(
	model: Model<Api>,
	apiKey: string,
	headers: Record<string, string> | undefined,
	systemPrompt: string,
	userPrompt: string,
	signal?: AbortSignal,
): Promise<string> {
	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: userPrompt }],
		timestamp: Date.now(),
	};

	const response = await complete(
		model,
		{
			systemPrompt,
			messages: [userMessage],
		},
		{
			apiKey,
			headers,
			maxTokens: 256,
		},
	);

	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || `Auto-review failed for ${model.provider}/${model.id}`);
	}

	if (response.stopReason === "aborted") {
		throw new Error("Auto-review aborted");
	}

	return getAssistantText(response.content);
}

interface AutoReviewResult {
	approved?: boolean;
	rationale: string;
	model?: string;
	riskLevel?: string;
	userAuthorization?: string;
	systemPrompt?: string;
	userPrompt?: string;
	rawResponse?: string;
	attempts: AutoReviewAttempt[];
}

interface AutoReviewAttempt {
	model: string;
	status:
		| "skipped-invalid-model-id"
		| "model-not-found"
		| "auth-error"
		| "missing-api-key"
		| "request-error"
		| "no-json"
		| "invalid-json"
		| "missing-decision"
		| "decision";
	detail: string;
	rawResponse?: string;
	decision?: "approve" | "deny";
	rationale?: string;
	riskLevel?: string;
	userAuthorization?: string;
}

interface GuardianMessageContent {
	summary: string;
	model?: string;
	rationale: string;
	riskLevel?: string;
	userAuthorization?: string;
	systemPrompt?: string;
	userPrompt?: string;
	rawResponse?: string;
	attempts?: AutoReviewAttempt[];
}

function hasAutoReviewDecision(review: AutoReviewResult): review is AutoReviewResult & { approved: boolean } {
	return typeof review.approved === "boolean";
}

function loadGuardianPrompt(): string {
	const promptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "guardian-prompt.md");
	return fs.readFileSync(promptPath, "utf-8");
}

async function runAutoReview(
	userPrompt: string,
	taskContext: string,
	modelRegistry: ModelRegistryLike,
	fallbackModel: Model<Api> | undefined,
	signal?: AbortSignal,
): Promise<AutoReviewResult | undefined> {
	const configuredModelIds = loadAutoReviewModels();
	const modelIds = [...configuredModelIds];
	if (fallbackModel) {
		const fallbackId = `${fallbackModel.provider}/${fallbackModel.id}`;
		if (!modelIds.includes(fallbackId)) {
			modelIds.push(fallbackId);
		}
	}
	if (modelIds.length === 0) return undefined;

	const systemPrompt = loadGuardianPrompt();
	const attempts: AutoReviewAttempt[] = [];

	const fullPrompt = `Current task context:
${taskContext}

${userPrompt}`;

	for (const modelId of modelIds) {
		const parts = modelId.split("/");
		if (parts.length !== 2) {
			attempts.push({
				model: modelId,
				status: "skipped-invalid-model-id",
				detail: "Configured model id is not in provider/model format.",
			});
			continue;
		}
		const [provider, id] = parts;

		const model = modelRegistry.find(provider, id);
		if (!model) {
			attempts.push({
				model: modelId,
				status: "model-not-found",
				detail: "Model registry could not resolve this model.",
			});
			continue;
		}

		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			attempts.push({
				model: modelId,
				status: "auth-error",
				detail: auth.error,
			});
			continue;
		}
		if (!auth.apiKey) {
			attempts.push({
				model: modelId,
				status: "missing-api-key",
				detail: "Model resolved but no API key was available.",
			});
			continue;
		}

		try {
			// Do not bind review requests to the main agent abort signal directly.
			// The approval check should survive normal streaming transitions long
			// enough to return a decision, while still timing out eventually.
			const responseText = await callAutoReviewModel(model, auth.apiKey, auth.headers, systemPrompt, fullPrompt, undefined);

			const jsonMatch = responseText.match(/\{[\s\S]*\}/);
			if (!jsonMatch) {
				attempts.push({
					model: modelId,
					status: "no-json",
					detail: "Model response did not contain a JSON object.",
					rawResponse: responseText,
				});
				continue;
			}

			let result: {
				decision?: string;
				rationale?: string;
				risk_level?: string;
				user_authorization?: string;
			};
			try {
				result = JSON.parse(jsonMatch[0]) as {
					decision?: string;
					rationale?: string;
					risk_level?: string;
					user_authorization?: string;
				};
			} catch (error) {
				attempts.push({
					model: modelId,
					status: "invalid-json",
					detail: error instanceof Error ? error.message : "Failed to parse JSON response.",
					rawResponse: responseText,
				});
				continue;
			}

			if (result.decision === "approve" || result.decision === "deny") {
				attempts.push({
					model: modelId,
					status: "decision",
					detail: result.rationale || "Model returned a decision.",
					rawResponse: responseText,
					decision: result.decision,
					rationale: result.rationale,
					riskLevel: result.risk_level,
					userAuthorization: result.user_authorization,
				});
				return {
					approved: result.decision === "approve",
					rationale: result.rationale || "No rationale provided",
					model: modelId,
					riskLevel: result.risk_level,
					userAuthorization: result.user_authorization,
					systemPrompt,
					userPrompt: fullPrompt,
					rawResponse: responseText,
					attempts,
				};
			}

			attempts.push({
				model: modelId,
				status: "missing-decision",
				detail: "Parsed JSON did not include decision=approve|deny.",
				rawResponse: responseText,
				rationale: result.rationale,
				riskLevel: result.risk_level,
				userAuthorization: result.user_authorization,
			});
		} catch (error) {
			attempts.push({
				model: modelId,
				status: "request-error",
				detail: error instanceof Error ? error.message : "Auto-review request failed.",
			});
			continue;
		}
	}

	return {
		rationale: "No auto-review model returned a final decision.",
		systemPrompt,
		userPrompt: fullPrompt,
		attempts,
	};
}

async function tryAutoReview(
	command: string,
	cwd: string,
	classification: Classification,
	taskContext: string,
	modelRegistry: ModelRegistryLike,
	fallbackModel: Model<Api> | undefined,
	signal?: AbortSignal,
): Promise<AutoReviewResult | undefined> {
	const userPrompt = `Review this shell command for auto-approval.

Context:
- current_directory: ${cwd}
- permission_level: auto
- command_required_level: ${classification.level}
- classifier_marked_dangerous: ${classification.dangerous ? "yes" : "no"}
- classifier_marked_needs_review: ${classification.needsReview ? "yes" : "no"}

Policy notes:
- Approve only if the command is both low enough risk and clearly useful for the agent's goal.
- Deny commands involving destructive deletion, privilege escalation, secret access, risky permission changes, external side effects, or unclear scope.
- Deny commands that are not clearly helpful, are only loosely related, or look exploratory beyond what the task needs.
- Treat commands that operate outside the project or affect user/system state as high risk unless the need is explicit and tightly scoped.

Decide whether this exact command should be auto-approved as written:
${command}`;

	return runAutoReview(userPrompt, taskContext, modelRegistry, fallbackModel, signal);
}

async function tryAutoReviewFileAccess(
	action: string,
	cwd: string,
	targetPath: string,
	reviewReason: string,
	taskContext: string,
	modelRegistry: ModelRegistryLike,
	fallbackModel: Model<Api> | undefined,
	signal?: AbortSignal,
): Promise<AutoReviewResult | undefined> {
	const userPrompt = `Review this file access request for auto-approval.

Context:
- current_directory: ${cwd}
- operation: ${action}
- target_path: ${targetPath}
- review_reason: ${reviewReason}

Policy notes:
- Approve only if this exact access is both low enough risk and clearly useful for the agent's goal.
- Ordinary project files inside the current working directory are usually safe when they directly support the task.
- Sensitive files, auth material, secrets, private keys, environment files, and VCS internals are high risk.
- Access outside the current working directory should usually be denied unless there is a clear, specific, task-related, low-risk justification.
- If the task relevance is weak, speculative, or unclear, deny.
- Judge this exact path and operation, not a hypothetical safer version.

Decide whether this specific file access should be auto-approved.`;

	return runAutoReview(userPrompt, taskContext, modelRegistry, fallbackModel, signal);
}

function sendAutoReviewThreadMessage(pi: ExtensionAPI, review: AutoReviewResult): void {
	const hasDecision = typeof review.approved === "boolean";
	const icon = hasDecision ? (review.approved ? "🔓" : "🚫") : "🧭";
	const status = hasDecision ? (review.approved ? "Auto-approved" : "Auto-review denied") : "Auto-review trace";
	const details = [
		review.riskLevel && `risk=${review.riskLevel}`,
		review.userAuthorization && `auth=${review.userAuthorization}`,
	]
		.filter(Boolean)
		.join(" ");
	const summary = hasDecision
		? details
			? `${icon} ${status} by ${review.model}: ${review.rationale} [${details}]`
			: `${icon} ${status} by ${review.model}: ${review.rationale}`
		: `${icon} ${status}: ${review.rationale}`;
	pi.sendMessage(
		{
			customType: "guardian",
			content: summary,
			details: {
				summary,
				model: review.model,
				rationale: review.rationale,
				riskLevel: review.riskLevel,
				userAuthorization: review.userAuthorization,
				systemPrompt: review.systemPrompt,
				userPrompt: review.userPrompt,
				rawResponse: review.rawResponse,
				attempts: review.attempts,
			} satisfies GuardianMessageContent,
			display: false,
		},
		{ triggerTurn: false },
	);
}

function formatGuardianMessageDetails(content: unknown, details: unknown): string {
	const message =
		details && typeof details === "object"
			? (details as GuardianMessageContent)
			: content && typeof content === "object"
				? (content as GuardianMessageContent)
				: undefined;

	if (!message) {
		return typeof content === "string" ? content : "";
	}

	return message.summary || message.rationale || "Guardian review";
}

// ============================================================================
// HANDLERS
// ============================================================================

/** Handle /mode config subcommand */
async function handleConfigSubcommand(_state: PermissionState, args: string, ctx: any): Promise<void> {
	const parts = args.trim().split(/\s+/);
	const action = parts[0];

	if (action === "show") {
		const config = loadPermissionConfig();
		const autoReviewModels = loadAutoReviewModels();
		const configStr = JSON.stringify({ ...config, autoReviewModels }, null, 2);
		ctx.ui.notify(`Mode config:
${configStr}`, "info");
		return;
	}

	if (action === "reset") {
		savePermissionConfig({});
		invalidateConfigCache();
		ctx.ui.notify("Mode config reset to defaults", "info");
		return;
	}

	const help = `Usage: /mode config <action>

Actions:
  show  - Display current configuration
  reset - Reset to default (empty)

Edit ~/.pi/agent/settings.json directly for full control:

{
  "permissionConfig": {
    "overrides": {
      "read": ["tmux list-*", "tmux show-*"],
      "auto": ["tmux *", "screen *"],
      "dangerous": ["rm -rf *", "dd if=* of=/dev/*"]
    },
    "prefixMappings": [
      { "from": "fvm flutter", "to": "flutter" },
      { "from": "nvm exec", "to": "" }
    ]
  },
  "autoReviewModels": [
    "anthropic/claude-sonnet-4-5",
    "openai/gpt-5.4"
  ]
}`;

	ctx.ui.notify(help, "info");
}

/** Handle /mode command */
export async function handleModeCommand(state: PermissionState, args: string, ctx: any): Promise<void> {
	const arg = args.trim().toLowerCase();

	if (arg === "config" || arg.startsWith("config ")) {
		const configArgs = arg.replace(/^config\s*/, "");
		await handleConfigSubcommand(state, configArgs, ctx);
		return;
	}

	if (arg && LEVELS.includes(arg as PermissionLevel)) {
		const newMode = arg as PermissionLevel;

		if (hasInteractiveUI(ctx)) {
			const scope = await ctx.ui.select("Save mode to:", ["Session only", "Global (persists)"]);
			if (!scope) return;

			setCurrentMode(state, newMode, scope === "Global (persists)", ctx);
			const saveMsg = scope === "Global (persists)" ? " (saved globally)" : " (session only)";
			ctx.ui.notify(`Mode: ${LEVEL_INFO[newMode].label}${saveMsg}`, "info");
		} else {
			setCurrentMode(state, newMode, false, ctx);
			ctx.ui.notify(`Mode: ${LEVEL_INFO[newMode].label}`, "info");
		}
		return;
	}

	if (!hasInteractiveUI(ctx)) {
		ctx.ui.notify(`Current mode: ${LEVEL_INFO[state.currentMode].label} (${LEVEL_INFO[state.currentMode].desc})`, "info");
		return;
	}

	const options = getModeRegistry().list().map((mode) => {
		const marker = mode.id === state.currentMode ? " ← current" : "";
		return `${mode.label}: ${mode.description}${marker}`;
	});

	const choice = await ctx.ui.select("Select mode", options);
	if (!choice) return;

	const selectedLabel = choice.split(":")[0].trim();
	const newMode = getModeRegistry().list().find((mode) => mode.label === selectedLabel)?.id;
	if (!newMode || newMode === state.currentMode) return;

	const scope = await ctx.ui.select("Save to:", ["Session only", "Global (persists)"]);
	if (!scope) return;

	setCurrentMode(state, newMode, scope === "Global (persists)", ctx);
	const saveMsg = scope === "Global (persists)" ? " (saved globally)" : " (session only)";
	ctx.ui.notify(`Mode: ${LEVEL_INFO[newMode].label}${saveMsg}`, "info");
}

export async function handlePermissionCommand(state: PermissionState, args: string, ctx: any): Promise<void> {
	return handleModeCommand(state, args, ctx);
}

/** Handle /review-mode command */
export async function handleReviewModeCommand(state: PermissionState, args: string, ctx: any): Promise<void> {
	const arg = args.trim().toLowerCase();

	if (arg && PERMISSION_MODES.includes(arg as PermissionMode)) {
		const newMode = arg as PermissionMode;

		if (hasInteractiveUI(ctx)) {
			const scope = await ctx.ui.select("Save review mode to:", ["Session only", "Global (persists)"]);
			if (!scope) return;

			setReviewMode(state, newMode, scope === "Global (persists)", ctx);
			const saveMsg = scope === "Global (persists)" ? " (saved globally)" : " (session only)";
			ctx.ui.notify(`Review mode: ${PERMISSION_MODE_INFO[newMode].label}${saveMsg}`, "info");
		} else {
			setReviewMode(state, newMode, false, ctx);
			ctx.ui.notify(`Review mode: ${PERMISSION_MODE_INFO[newMode].label}`, "info");
		}
		return;
	}

	if (!hasInteractiveUI(ctx)) {
		ctx.ui.notify(`Current review mode: ${PERMISSION_MODE_INFO[state.reviewMode].label} (${PERMISSION_MODE_INFO[state.reviewMode].desc})`, "info");
		return;
	}

	const options = PERMISSION_MODES.map((mode) => {
		const info = PERMISSION_MODE_INFO[mode];
		const marker = mode === state.reviewMode ? " ← current" : "";
		return `${info.label}: ${info.desc}${marker}`;
	});

	const choice = await ctx.ui.select("Select review mode", options);
	if (!choice) return;

	const selectedLabel = choice.split(":")[0].trim();
	const newMode = PERMISSION_MODES.find((m) => PERMISSION_MODE_INFO[m].label === selectedLabel);
	if (!newMode || newMode === state.reviewMode) return;

	const scope = await ctx.ui.select("Save to:", ["Session only", "Global (persists)"]);
	if (!scope) return;

	setReviewMode(state, newMode, scope === "Global (persists)", ctx);
	const saveMsg = scope === "Global (persists)" ? " (saved globally)" : " (session only)";
	ctx.ui.notify(`Review mode: ${PERMISSION_MODE_INFO[newMode].label}${saveMsg}`, "info");
}

export async function handlePermissionModeCommand(state: PermissionState, args: string, ctx: any): Promise<void> {
	return handleReviewModeCommand(state, args, ctx);
}

/** Handle session_start - initialize mode and show status */
export function handleSessionStart(state: PermissionState, ctx: any): void {
	const envLevel = process.env.PI_PERMISSION_LEVEL?.toLowerCase();
	if (envLevel) {
		const legacyMap: Record<string, PermissionLevel> = {
			minimal: "read",
			low: "edit",
			medium: "auto",
			high: "auto",
			bypassed: "auto",
		};
		const mapped = legacyMap[envLevel] || (LEVELS.includes(envLevel as PermissionLevel) ? (envLevel as PermissionLevel) : null);
		if (mapped) {
			state.currentMode = mapped;
		}
	} else {
		const globalLevel = loadGlobalPermission();
		if (globalLevel) {
			state.currentMode = globalLevel;
		}
	}

	if (ctx.hasUI) {
		const globalMode = loadGlobalPermissionMode();
		if (globalMode) {
			state.reviewMode = globalMode;
		}
	}

	if (ctx.hasUI) {
		ctx.ui?.setStatus?.("authority", getStatusText(state.currentMode));
		if (!isQuietMode(ctx)) {
			ctx.ui.notify(`Mode: ${LEVEL_INFO[state.currentMode].label} (use /mode to change)`, "info");
		}
		if (state.reviewMode === "block") {
			ctx.ui.notify("Review mode: Block (use /review-mode to change)", "info");
		}
		const autoReviewModels = loadAutoReviewModels();
		if (state.currentMode === "auto" && autoReviewModels.length > 0) {
			ctx.ui.notify(`Auto-review models: ${autoReviewModels.join(", ")}`, "info");
		}
	}
}

/** Handle bash tool_call - check permission and prompt if needed */
export async function handleBashToolCall(
	activeMode: PermissionLevel,
	state: PermissionState,
	command: string,
	ctx: any,
	pi: ExtensionAPI,
): Promise<ToolHandlerResult> {
	const classification = classifyCommand(command);

	if (classification.dangerous) {
		if (!hasInteractiveUI(ctx)) {
			return {
				block: true,
				reason: `Dangerous command requires confirmation: ${command}
Configure autoReviewModels in settings.json to enable auto-review in non-interactive mode.`,
			};
		}

		if (state.reviewMode === "block") {
			return {
				block: true,
				reason: `Blocked by review mode (block). Dangerous command: ${command}
Use /review-mode ask to enable confirmations.`,
			};
		}

		if (activeMode === "auto" && ctx.modelRegistry) {
			const review = await tryAutoReview(
				command,
				ctx.cwd,
				classification,
				getCurrentTaskContext(ctx),
				ctx.modelRegistry,
				ctx.model,
				ctx.signal,
			);
			if (review) {
				sendAutoReviewThreadMessage(pi, review);
				if (hasAutoReviewDecision(review) && review.approved) {
					ctx.ui.notify(`🔓 Auto-approved by ${review.model}: ${review.rationale}`, "info");
					return undefined;
				}
				if (hasAutoReviewDecision(review)) {
					playPermissionSound();
					const choice = await ctx.ui.select(
						`⚠️ Dangerous command — auto-review recommends denial by ${review.model}: ${review.rationale}`,
						["Allow once", "Cancel"],
					);
					if (choice === "Allow once") return undefined;
					return { block: true, reason: "Cancelled" };
				}
			}
		}

		playPermissionSound();
		const choice = await ctx.ui.select(`⚠️ Dangerous command`, ["Allow once", "Cancel"]);
		if (choice !== "Allow once") {
			return { block: true, reason: "Cancelled" };
		}
		return undefined;
	}

	const requiredLevel = classification.level as "read" | "edit" | "auto";
	if (!modeAllowsRequiredLevel(activeMode, requiredLevel)) {
		const requiredInfo = LEVEL_INFO[requiredLevel];

		if (!hasInteractiveUI(ctx)) {
			return {
				block: true,
				reason: `Blocked by mode (${activeMode}). Command: ${command}
Allowed at this mode: ${LEVEL_ALLOWED_DESC[activeMode]}
User can re-run with: PI_PERMISSION_LEVEL=${requiredLevel} pi -p "..."`,
			};
		}

		if (state.reviewMode === "block") {
			return {
				block: true,
				reason: `Blocked by mode (${activeMode}, review mode: block). Command: ${command}
Requires ${requiredInfo.label}. Allowed at this mode: ${LEVEL_ALLOWED_DESC[activeMode]}
Use /mode ${requiredLevel} or /review-mode ask to enable prompts.`,
			};
		}

		playPermissionSound();
		const choice = await ctx.ui.select(`Requires ${requiredInfo.label}`, ["Allow once", `Allow mode (${requiredInfo.label})`, "Cancel"]);
		if (choice === "Allow once") return undefined;
		if (choice === `Allow mode (${requiredInfo.label})`) {
			setCurrentMode(state, requiredLevel, true, ctx);
			ctx.ui.notify(`Mode → ${requiredInfo.label} (saved globally)`, "info");
			return undefined;
		}
		return { block: true, reason: "Cancelled" };
	}

	if (classification.needsReview && activeMode === "auto") {
		if (!hasInteractiveUI(ctx)) {
			return {
				block: true,
				reason: `High-risk command requires auto-review: ${command}
Configure autoReviewModels in settings.json to enable auto-review in non-interactive mode.`,
			};
		}

		if (state.reviewMode === "block") {
			return {
				block: true,
				reason: `Blocked by review mode (block). High-risk command: ${command}`,
			};
		}

		if (ctx.modelRegistry) {
			const review = await tryAutoReview(
				command,
				ctx.cwd,
				classification,
				getCurrentTaskContext(ctx),
				ctx.modelRegistry,
				ctx.model,
				ctx.signal,
			);
			if (review) {
				sendAutoReviewThreadMessage(pi, review);
				if (hasAutoReviewDecision(review) && review.approved) {
					ctx.ui.notify(`🔓 Auto-approved by ${review.model}: ${review.rationale}`, "info");
					return undefined;
				}
				if (hasAutoReviewDecision(review)) {
					playPermissionSound();
					const choice = await ctx.ui.select(
						`🔍 High-risk command — auto-review recommends denial by ${review.model}: ${review.rationale}`,
						["Allow once", "Cancel"],
					);
					if (choice === "Allow once") return undefined;
					return { block: true, reason: "Cancelled" };
				}
			}
		}

		playPermissionSound();
		const choice = await ctx.ui.select(`🔍 High-risk command (auto-review unavailable)`, ["Allow once", "Cancel"]);
		if (choice !== "Allow once") {
			return { block: true, reason: "Cancelled" };
		}
	}

	return undefined;
}

/** Options for handleWriteToolCall */
export interface WriteToolCallOptions {
	activeMode: PermissionLevel;
	state: PermissionState;
	toolName: "write" | "edit";
	filePath: string;
	ctx: any;
	pi: ExtensionAPI;
}

/** Handle read tool_call - scope file reads by cwd and sensitivity */
export async function handleReadToolCall(
	activeMode: PermissionLevel,
	state: PermissionState,
	filePath: string,
	ctx: any,
	pi: ExtensionAPI,
): Promise<ToolHandlerResult> {
	const action = "Read";
	const target = inspectFileAccessTarget(filePath, ctx);

	if (!target.reviewReason) {
		return undefined;
	}

	if (activeMode !== "auto") {
		const requiredInfo = LEVEL_INFO.auto;

		if (!hasInteractiveUI(ctx)) {
			return {
				block: true,
				reason:
					`Blocked by mode (${activeMode}). ${action}: ${filePath}
` +
					`Resolved path: ${target.resolvedPath}
` +
					`Reason: ${target.reviewReason}
` +
					`Allowed at this mode: ${LEVEL_ALLOWED_DESC[activeMode]}
` +
					`User can re-run with: PI_PERMISSION_LEVEL=auto pi -p "..."`,
			};
		}

		if (state.reviewMode === "block") {
			return {
				block: true,
				reason:
					`Blocked by mode (${activeMode}, review mode: block). ${action}: ${filePath}
` +
					`Resolved path: ${target.resolvedPath}
` +
					`Reason: ${target.reviewReason}
` +
					`Requires ${requiredInfo.label}. Allowed at this mode: ${LEVEL_ALLOWED_DESC[activeMode]}
` +
					`Use /mode auto or /review-mode ask to enable prompts.`,
			};
		}

		playPermissionSound();
		const choice = await ctx.ui.select(`Requires ${requiredInfo.label}: ${action} ${filePath}`, ["Allow once", "Approve and auto review", "Cancel"]);
		if (choice === "Allow once") return undefined;
		if (choice === "Approve and auto review") {
			setCurrentMode(state, "auto", true, ctx);
			ctx.ui.notify(`Mode → ${requiredInfo.label} (saved globally)`, "info");
		} else {
			return { block: true, reason: "Cancelled" };
		}
	}

	if (!hasInteractiveUI(ctx)) {
		return {
			block: true,
			reason:
				`Sensitive or out-of-scope file read requires auto-review: ${action} ${filePath}
` +
				`Resolved path: ${target.resolvedPath}
` +
				`Reason: ${target.reviewReason}
` +
				`Configure autoReviewModels in settings.json to enable this in non-interactive mode.`,
		};
	}

	if (ctx.modelRegistry) {
		const review = await tryAutoReviewFileAccess(
			action,
			target.cwd,
			target.resolvedPath,
			target.reviewReason,
			getCurrentTaskContext(ctx),
			ctx.modelRegistry,
			ctx.model,
			ctx.signal,
		);
		if (review) {
			sendAutoReviewThreadMessage(pi, review);
			if (hasAutoReviewDecision(review) && review.approved) {
				ctx.ui.notify(`🔓 Auto-approved by ${review.model}: ${review.rationale}`, "info");
				return undefined;
			}
			if (hasAutoReviewDecision(review)) {
				playPermissionSound();
				const choice = await ctx.ui.select(
					`🔍 Auto-review recommends denial for ${action} ${filePath} by ${review.model}: ${review.rationale}`,
					["Allow once", "Cancel"],
				);
				if (choice === "Allow once") return undefined;
				return { block: true, reason: "Cancelled" };
			}
		}
	}

	if (state.reviewMode === "block") {
		return {
			block: true,
			reason:
				`Blocked by review mode (block). ${action}: ${filePath}
` +
				`Resolved path: ${target.resolvedPath}
` +
				`Reason: ${target.reviewReason}
` +
				`Auto-review was required but no review model returned a decision.`,
		};
	}

	playPermissionSound();
	const choice = await ctx.ui.select(`🔍 Auto-review required: ${action} ${filePath}`, ["Allow once", "Cancel"]);
	if (choice === "Allow once") return undefined;
	return { block: true, reason: "Cancelled" };
}

/** Handle write/edit tool_call - check permission and prompt if needed */
export async function handleWriteToolCall(opts: WriteToolCallOptions): Promise<ToolHandlerResult> {
	const { activeMode, state, toolName, filePath, ctx, pi } = opts;

	const action = toolName === "write" ? "Write" : "Edit";
	const target = inspectFileAccessTarget(filePath, ctx);
	const needsReview = Boolean(target.reviewReason);
	const requiredLevel: "edit" | "auto" = needsReview ? "auto" : "edit";

	if (!modeSupportsFileWrites(activeMode, filePath)) {
		const modeLabel = LEVEL_INFO[activeMode].label;
		const planHint = activeMode === "plan" ? "Plan mode only permits Markdown (.md/.mdx) file modifications. " : "";
		return {
			block: true,
			reason:
				`Blocked in ${modeLabel} mode. ${action}: ${filePath}
` +
				`Resolved path: ${target.resolvedPath}
` +
				`${planHint}Use /mode edit or /mode auto before retrying.`,
		};
	}

	if (!modeAllowsRequiredLevel(activeMode, requiredLevel)) {
		const requiredInfo = LEVEL_INFO[requiredLevel];
		if (!hasInteractiveUI(ctx)) {
			return {
				block: true,
				reason:
					`Blocked by mode (${activeMode}). ${action}: ${filePath}
` +
					`Resolved path: ${target.resolvedPath}
` +
					(target.reviewReason ? `Reason: ${target.reviewReason}
` : "") +
					`Allowed at this mode: ${LEVEL_ALLOWED_DESC[activeMode]}
` +
					`User can re-run with: PI_PERMISSION_LEVEL=${requiredLevel} pi -p "..."`,
			};
		}

		if (state.reviewMode === "block") {
			return {
				block: true,
				reason:
					`Blocked by mode (${activeMode}, review mode: block). ${action}: ${filePath}
` +
					`Resolved path: ${target.resolvedPath}
` +
					(target.reviewReason ? `Reason: ${target.reviewReason}
` : "") +
					`Requires ${requiredInfo.label}. Allowed at this mode: ${LEVEL_ALLOWED_DESC[activeMode]}
` +
					`Use /mode ${requiredLevel} or /review-mode ask to enable prompts.`,
			};
		}

		playPermissionSound();
		const choice = await ctx.ui.select(`Requires ${requiredInfo.label}: ${action} ${filePath}`, ["Allow once", "Approve and auto review", "Cancel"]);
		if (choice === "Allow once") return undefined;
		if (choice === "Approve and auto review") {
			setCurrentMode(state, requiredLevel, true, ctx);
			ctx.ui.notify(`Mode → ${requiredInfo.label} (saved globally)`, "info");
		} else {
			return { block: true, reason: "Cancelled" };
		}
	}

	if (!needsReview) {
		return undefined;
	}

	if (activeMode === "edit" || activeMode === "plan") {
		const modeLabel = LEVEL_INFO[activeMode].label;
		return {
			block: true,
			reason:
				`Blocked in ${modeLabel} mode. ${action}: ${filePath}
` +
				`Resolved path: ${target.resolvedPath}
` +
				`Reason: ${target.reviewReason}
` +
				`${modeLabel} mode only auto-allows non-sensitive files inside ${target.cwd}. Use /mode auto to enable auto-review for this request.`,
		};
	}

	if (!hasInteractiveUI(ctx)) {
		return {
			block: true,
			reason:
				`Sensitive or out-of-scope file edit requires auto-review: ${action} ${filePath}
` +
				`Resolved path: ${target.resolvedPath}
` +
				`Reason: ${target.reviewReason}
` +
				`Configure autoReviewModels in settings.json to enable this in non-interactive mode.`,
		};
	}

	if (ctx.modelRegistry) {
		const review = await tryAutoReviewFileAccess(
			action,
			target.cwd,
			target.resolvedPath,
			target.reviewReason!,
			getCurrentTaskContext(ctx),
			ctx.modelRegistry,
			ctx.model,
			ctx.signal,
		);
		if (review) {
			sendAutoReviewThreadMessage(pi, review);
			if (hasAutoReviewDecision(review) && review.approved) {
				ctx.ui.notify(`🔓 Auto-approved by ${review.model}: ${review.rationale}`, "info");
				return undefined;
			}
			if (hasAutoReviewDecision(review)) {
				playPermissionSound();
				const choice = await ctx.ui.select(
					`🔍 Auto-review recommends denial for ${action} ${filePath} by ${review.model}: ${review.rationale}`,
					["Allow once", "Cancel"],
				);
				if (choice === "Allow once") return undefined;
				return { block: true, reason: "Cancelled" };
			}
		}
	}

	if (state.reviewMode === "block") {
		return {
			block: true,
			reason:
				`Blocked by review mode (block). ${action}: ${filePath}
` +
				`Resolved path: ${target.resolvedPath}
` +
				`Reason: ${target.reviewReason}
` +
				`Auto-review was required but no review model returned a decision.`,
		};
	}

	playPermissionSound();
	const choice = await ctx.ui.select(`🔍 Auto-review required: ${action} ${filePath}`, ["Allow once", "Cancel"]);
	if (choice === "Allow once") return undefined;
	return { block: true, reason: "Cancelled" };
}

async function promptForModeUpgrade(
	state: PermissionState,
	ctx: any,
	targetMode: PermissionLevel,
	message: string,
): Promise<"allow-once" | "upgraded" | "cancel"> {
	if (!hasInteractiveUI(ctx)) return "cancel";
	if (state.reviewMode === "block") return "cancel";
	playPermissionSound();
	const label = LEVEL_INFO[targetMode].label;
	const choice = await ctx.ui.select(message, ["Allow once", `Allow mode (${label})`, "Cancel"]);
	if (choice === "Allow once") return "allow-once";
	if (choice === `Allow mode (${label})`) {
		setCurrentMode(state, targetMode, true, ctx);
		ctx.ui.notify(`Mode → ${label} (saved globally)`, "info");
		return "upgraded";
	}
	return "cancel";
}

async function handleReviewedFileAccess(
	action: string,
	target: { cwd: string; resolvedPath: string; reviewReason?: string },
	ctx: any,
	pi: ExtensionAPI,
	state: PermissionState,
): Promise<ToolHandlerResult> {
	if (!target.reviewReason) return undefined;
	if (!hasInteractiveUI(ctx)) {
		return {
			block: true,
			reason:
				`${action} requires auto-review: ${target.resolvedPath}\n` +
				`Reason: ${target.reviewReason}\n` +
				`Configure autoReviewModels in settings.json to enable this in non-interactive mode.`,
		};
	}
	if (ctx.modelRegistry) {
		const review = await tryAutoReviewFileAccess(
			action,
			target.cwd,
			target.resolvedPath,
			target.reviewReason,
			getCurrentTaskContext(ctx),
			ctx.modelRegistry,
			ctx.model,
			ctx.signal,
		);
		if (review) {
			sendAutoReviewThreadMessage(pi, review);
			if (hasAutoReviewDecision(review) && review.approved) {
				ctx.ui.notify(`🔓 Auto-approved by ${review.model}: ${review.rationale}`, "info");
				return undefined;
			}
			if (hasAutoReviewDecision(review)) {
				playPermissionSound();
				const choice = await ctx.ui.select(
					`🔍 Auto-review recommends denial for ${action} ${target.resolvedPath} by ${review.model}: ${review.rationale}`,
					["Allow once", "Cancel"],
				);
				if (choice === "Allow once") return undefined;
				return { block: true, reason: "Cancelled" };
			}
		}
	}
	if (state.reviewMode === "block") {
		return {
			block: true,
			reason:
				`Blocked by review mode (block). ${action}: ${target.resolvedPath}\n` +
				`Reason: ${target.reviewReason}\n` +
				`Auto-review was required but no review model returned a decision.`,
		};
	}
	playPermissionSound();
	const choice = await ctx.ui.select(`🔍 Auto-review required: ${action} ${target.resolvedPath}`, ["Allow once", "Cancel"]);
	if (choice === "Allow once") return undefined;
	return { block: true, reason: "Cancelled" };
}

async function handlePolicyDrivenToolCall(
	activeMode: GuardianModeDefinition,
	state: PermissionState,
	event: any,
	ctx: any,
	pi: ExtensionAPI,
): Promise<ToolHandlerResult> {
	if (event.toolName === "bash") {
		const policy = activeMode.policies.bash;
		if (!policy || policy.kind !== "bash") return { block: true, reason: `No bash policy for ${activeMode.id} mode.` };
		const result = evaluateBashAccess(policy, event.input.command as string);
		if (result.decision === "allow") return undefined;
		if (result.decision === "review") {
			return handleBashToolCall(activeMode.id, state, event.input.command as string, ctx, pi);
		}
		if (result.decision === "prompt-upgrade" && result.targetMode) {
			const upgrade = await promptForModeUpgrade(state, ctx, result.targetMode, `Requires ${LEVEL_INFO[result.targetMode].label}`);
			if (upgrade === "allow-once" || upgrade === "upgraded") return undefined;
			return { block: true, reason: "Cancelled" };
		}
		return { block: true, reason: result.reason ?? `Blocked by ${activeMode.label} mode.` };
	}

	if (event.toolName === "read") {
		const policy = activeMode.policies.read;
		if (!policy || policy.kind !== "read") return { block: true, reason: `No read policy for ${activeMode.id} mode.` };
		const result = evaluateReadAccess(policy, event.input.path as string, getSessionCwd(ctx));
		if (result.decision === "allow") return undefined;
		if (result.decision === "review") return handleReviewedFileAccess("Read", result.target, ctx, pi, state);
		if (result.decision === "prompt-upgrade" && result.targetMode) {
			const upgrade = await promptForModeUpgrade(state, ctx, result.targetMode, `Requires ${LEVEL_INFO[result.targetMode].label}: Read ${event.input.path as string}`);
			if (upgrade === "allow-once") return undefined;
			if (upgrade === "upgraded") return handleReviewedFileAccess("Read", result.target, ctx, pi, state);
			return { block: true, reason: "Cancelled" };
		}
		return { block: true, reason: result.reason ?? `Blocked by ${activeMode.label} mode.` };
	}

	if (event.toolName === "write" || event.toolName === "edit") {
		const policy = activeMode.policies[event.toolName];
		if (!policy || policy.kind !== "write") return { block: true, reason: `No ${event.toolName} policy for ${activeMode.id} mode.` };
		const action = event.toolName === "write" ? "Write" : "Edit";
		const result = evaluateWriteAccess(policy, event.input.path as string, getSessionCwd(ctx));
		if (result.decision === "allow") return undefined;
		if (result.decision === "review") return handleReviewedFileAccess(action, result.target, ctx, pi, state);
		if (result.decision === "prompt-upgrade" && result.targetMode) {
			const upgrade = await promptForModeUpgrade(state, ctx, result.targetMode, `Requires ${LEVEL_INFO[result.targetMode].label}: ${action} ${event.input.path as string}`);
			if (upgrade === "allow-once") return undefined;
			if (upgrade === "upgraded") return handleReviewedFileAccess(action, result.target, ctx, pi, state);
			return { block: true, reason: "Cancelled" };
		}
		const target = inspectSharedFileAccessTarget(event.input.path as string, getSessionCwd(ctx));
		return {
			block: true,
			reason: `${result.reason ?? `Blocked by ${activeMode.label} mode.`}\nResolved path: ${target.resolvedPath}`,
		};
	}

	return undefined;
}

// ============================================================================
// Extension entry point
// ============================================================================

export function setModeSessionOnly(state: PermissionState, mode: PermissionLevel, ctx: any): void {
	setCurrentMode(state, mode, false, ctx);
}

export function registerGuardianExtension(pi: ExtensionAPI, registeredModes: GuardianModeDefinition[]): PermissionState {
	modeRegistry = createModeRegistry(registeredModes);
	const state = createInitialState();

	pi.registerMessageRenderer("guardian", (message, _options, theme) => {
		return new Text(theme.fg("warning", formatGuardianMessageDetails(message.content, message.details)), 0, 0);
	});

	pi.registerCommand("mode", {
		description: "View or change guardian mode",
		handler: (args, ctx) => handleModeCommand(state, args, ctx),
	});
	for (const mode of getModeRegistry().list()) {
		pi.registerCommand(`mode:${mode.id}`, {
			description: `Switch directly to ${mode.label} mode`,
			handler: async (_args, ctx) => handleModeCommand(state, mode.id, ctx),
		});
	}
	pi.registerCommand("review-mode", {
		description: "Set guardian review mode (ask or block)",
		handler: (args, ctx) => handleReviewModeCommand(state, args, ctx),
	});

	pi.on("session_start", async (_event, ctx) => {
		handleSessionStart(state, ctx);
	});
	pi.on("before_agent_start", async (event) => {
		const activeMode = getModeRegistry().get(state.currentMode);
		if (!activeMode.systemPrompt) return undefined;
		const base = event.systemPrompt ?? "";
		return {
			systemPrompt: base ? `${base}\n\n${activeMode.systemPrompt}` : activeMode.systemPrompt,
		};
	});
	pi.on("tool_call", async (event, ctx) => {
		const activeMode = getModeRegistry().get(state.currentMode);
		if (!["bash", "read", "write", "edit"].includes(event.toolName)) return undefined;
		if (!activeMode.registeredTools.includes(event.toolName)) {
			return { block: true, reason: `${LEVEL_INFO[activeMode.id].label} mode does not register the ${event.toolName} tool.` };
		}
		return handlePolicyDrivenToolCall(activeMode, state, event, ctx, pi);
	});

	return state;
}
