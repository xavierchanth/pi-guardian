/**
 * Permission Extension for pi-coding-agent
 *
 * Implements layered permission control with auto-review for auto mode.
 *
 * Interactive mode:
 *   Use `/permission` command to view or change the level.
 *   Use `/permission-mode` to switch between ask vs block.
 *   When changing via command, you'll be asked: session-only or global?
 *
 * Print mode (pi -p):
 *   Set PI_PERMISSION_LEVEL env var: PI_PERMISSION_LEVEL=auto pi -p "task"
 *   Operations beyond level will exit with helpful error message.
 *
 * Levels:
 *   read - Read-only mode (default)
 *          ✅ Read files, ls, grep, git status/log/diff
 *          ❌ No file modifications, no commands with side effects
 *
 *   edit - File operations only
 *          ✅ Create/edit files in project directory
 *          ❌ No package installs, no git commits, no builds
 *
 *   auto - Development operations with auto-review
 *          ✅ npm/pip install, git commit/pull, make/build (auto-approved)
 *          🔍 High-risk operations (git push, deploy, sudo, rm -rf) sent to
 *            configured auto-review models for approval
 *          ❌ If no auto-review model is available, prompts user
 *
 * Auto-review models:
 *   Configure in ~/.pi/agent/settings.json:
 *   {
 *     "autoReviewModels": [
 *       "anthropic/claude-sonnet-4-5",
 *       "openai/gpt-5.4"
 *     ]
 *   }
 *
 * Usage:
 *   pi --extension ./permission/index.ts
 *
 * Or add to ~/.pi/agent/extensions/ or .pi/extensions/ for automatic loading.
 */

import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { complete, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	type PermissionLevel,
	type PermissionMode,
	LEVELS,
	LEVEL_INDEX,
	LEVEL_INFO,
	LEVEL_ALLOWED_DESC,
	PERMISSION_MODES,
	PERMISSION_MODE_INFO,
	loadGlobalPermission,
	saveGlobalPermission,
	loadGlobalPermissionMode,
	saveGlobalPermissionMode,
	classifyCommand,
	loadPermissionConfig,
	savePermissionConfig,
	invalidateConfigCache,
	loadAutoReviewModels,
	type PermissionConfig,
	type Classification,
} from "./permission-core.js";

// Re-export types and constants needed by the hook
export {
	type PermissionLevel,
	type PermissionMode,
	LEVELS,
	LEVEL_INFO,
	PERMISSION_MODES,
	PERMISSION_MODE_INFO,
};

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
const DIM = "\x1b[2m";

const LEVEL_COLORS: Record<PermissionLevel, string> = {
	read: RED,
	edit: YELLOW,
	auto: CYAN,
};

function getStatusText(level: PermissionLevel): string {
	const info = LEVEL_INFO[level];
	const color = LEVEL_COLORS[level];
	return `${BOLD}${color}${info.label}${RESET} ${DIM}- ${info.desc}${RESET}`;
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

	// In non-interactive modes (rpc/json/print), UI prompts are not desired.
	// We still allow notifications, but block instead of asking.
	const mode = getPiModeFromArgv()?.toLowerCase();
	if (mode && mode !== "interactive") return false;

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

export interface PermissionState {
	currentLevel: PermissionLevel;
	isSessionOnly: boolean;
	permissionMode: PermissionMode;
	isModeSessionOnly: boolean;
}

export function createInitialState(): PermissionState {
	return {
		currentLevel: "read",
		isSessionOnly: false,
		permissionMode: "ask",
		isModeSessionOnly: false,
	};
}

function setLevel(state: PermissionState, level: PermissionLevel, saveGlobally: boolean, ctx: any): void {
	state.currentLevel = level;
	state.isSessionOnly = !saveGlobally;
	if (saveGlobally) {
		saveGlobalPermission(level);
	}
	if (ctx.ui?.setStatus) {
		ctx.ui.setStatus("authority", getStatusText(level));
	}
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

function setMode(state: PermissionState, mode: PermissionMode, saveGlobally: boolean, ctx: any): void {
	state.permissionMode = mode;
	state.isModeSessionOnly = !saveGlobally;
	if (saveGlobally) {
		saveGlobalPermissionMode(mode);
	}
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
			temperature: 0,
			signal,
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
	approved: boolean;
	rationale: string;
	model?: string;
}

async function runAutoReview(
	userPrompt: string,
	modelRegistry: ModelRegistryLike,
	signal?: AbortSignal,
): Promise<AutoReviewResult | undefined> {
	const modelIds = loadAutoReviewModels();
	if (modelIds.length === 0) return undefined;

	const systemPrompt = `You are a security reviewer for an AI coding assistant. Your job is to review requests and decide whether they should be allowed.

Respond with ONLY a JSON object in this exact format:
{"decision": "approve" | "deny", "rationale": "brief explanation"}`;

	for (const modelId of modelIds) {
		const parts = modelId.split("/");
		if (parts.length !== 2) continue;
		const [provider, id] = parts;

		const model = modelRegistry.find(provider, id);
		if (!model) continue;

		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) continue;
		if (!auth.apiKey) continue;

		try {
			const responseText = await callAutoReviewModel(model, auth.apiKey, auth.headers, systemPrompt, userPrompt, signal);

			const jsonMatch = responseText.match(/\{[\s\S]*\}/);
			if (!jsonMatch) continue;

			const result = JSON.parse(jsonMatch[0]) as { decision?: string; rationale?: string };
			if (result.decision === "approve" || result.decision === "deny") {
				return {
					approved: result.decision === "approve",
					rationale: result.rationale || "No rationale provided",
					model: modelId,
				};
			}
		} catch {
			continue;
		}
	}

	return undefined;
}

async function tryAutoReview(
	command: string,
	cwd: string,
	classification: Classification,
	modelRegistry: ModelRegistryLike,
	signal?: AbortSignal,
): Promise<AutoReviewResult | undefined> {
	const userPrompt = `Review this shell command:

Current directory: ${cwd}
Permission level: auto (routine dev ops are auto-approved; high-risk operations require review)
Command required level: ${classification.level}
Dangerous: ${classification.dangerous ? "yes" : "no"}
Needs review: ${classification.needsReview ? "yes" : "no"}

Command: ${command}`;

	return runAutoReview(userPrompt, modelRegistry, signal);
}

async function tryAutoReviewFileAccess(
	action: string,
	cwd: string,
	targetPath: string,
	reviewReason: string,
	modelRegistry: ModelRegistryLike,
	signal?: AbortSignal,
): Promise<AutoReviewResult | undefined> {
	const userPrompt = `Review this file access request:

Current directory: ${cwd}
Operation: ${action}
Target file: ${targetPath}
Reason review is required: ${reviewReason}

Policy:
- Routine file edits inside the current working directory are allowed.
- Sensitive files and files outside the current working directory require review.

Respond based on whether this specific edit target should be allowed.`;

	return runAutoReview(userPrompt, modelRegistry, signal);
}

// ============================================================================
// HANDLERS
// ============================================================================

/** Handle /permission config subcommand */
async function handleConfigSubcommand(state: PermissionState, args: string, ctx: any): Promise<void> {
	const parts = args.trim().split(/\s+/);
	const action = parts[0];

	if (action === "show") {
		const config = loadPermissionConfig();
		const autoReviewModels = loadAutoReviewModels();
		const configStr = JSON.stringify(
			{ ...config, autoReviewModels },
			null,
			2,
		);
		ctx.ui.notify(`Permission Config:\n${configStr}`, "info");
		return;
	}

	if (action === "reset") {
		savePermissionConfig({});
		invalidateConfigCache();
		ctx.ui.notify("Permission config reset to defaults", "info");
		return;
	}

	// Show help
	const help = `Usage: /permission config <action>

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

/** Handle /permission command */
export async function handlePermissionCommand(state: PermissionState, args: string, ctx: any): Promise<void> {
	const arg = args.trim().toLowerCase();

	// Handle config subcommand
	if (arg === "config" || arg.startsWith("config ")) {
		const configArgs = arg.replace(/^config\s*/, "");
		await handleConfigSubcommand(state, configArgs, ctx);
		return;
	}

	// Direct level set: /permission auto
	if (arg && LEVELS.includes(arg as PermissionLevel)) {
		const newLevel = arg as PermissionLevel;

		if (hasInteractiveUI(ctx)) {
			const scope = await ctx.ui.select("Save permission level to:", ["Session only", "Global (persists)"]);
			if (!scope) return;

			setLevel(state, newLevel, scope === "Global (persists)", ctx);
			const saveMsg = scope === "Global (persists)" ? " (saved globally)" : " (session only)";
			ctx.ui.notify(`Permission: ${LEVEL_INFO[newLevel].label}${saveMsg}`, "info");
		} else {
			setLevel(state, newLevel, false, ctx);
			ctx.ui.notify(`Permission: ${LEVEL_INFO[newLevel].label}`, "info");
		}
		return;
	}

	// Show current level (no UI)
	if (!hasInteractiveUI(ctx)) {
		ctx.ui.notify(
			`Current permission: ${LEVEL_INFO[state.currentLevel].label} (${LEVEL_INFO[state.currentLevel].desc})`,
			"info",
		);
		return;
	}

	// Show selector
	const options = LEVELS.map((level) => {
		const info = LEVEL_INFO[level];
		const marker = level === state.currentLevel ? " ← current" : "";
		return `${info.label}: ${info.desc}${marker}`;
	});

	const choice = await ctx.ui.select("Select permission level", options);
	if (!choice) return;

	const selectedLabel = choice.split(":")[0].trim();
	const newLevel = LEVELS.find((l) => LEVEL_INFO[l].label === selectedLabel);
	if (!newLevel || newLevel === state.currentLevel) return;

	const scope = await ctx.ui.select("Save to:", ["Session only", "Global (persists)"]);
	if (!scope) return;

	setLevel(state, newLevel, scope === "Global (persists)", ctx);
	const saveMsg = scope === "Global (persists)" ? " (saved globally)" : " (session only)";
	ctx.ui.notify(`Permission: ${LEVEL_INFO[newLevel].label}${saveMsg}`, "info");
}

/** Handle /permission-mode command */
export async function handlePermissionModeCommand(state: PermissionState, args: string, ctx: any): Promise<void> {
	const arg = args.trim().toLowerCase();

	if (arg && PERMISSION_MODES.includes(arg as PermissionMode)) {
		const newMode = arg as PermissionMode;

		if (hasInteractiveUI(ctx)) {
			const scope = await ctx.ui.select("Save permission mode to:", ["Session only", "Global (persists)"]);
			if (!scope) return;

			setMode(state, newMode, scope === "Global (persists)", ctx);
			const saveMsg = scope === "Global (persists)" ? " (saved globally)" : " (session only)";
			ctx.ui.notify(`Permission mode: ${PERMISSION_MODE_INFO[newMode].label}${saveMsg}`, "info");
		} else {
			setMode(state, newMode, false, ctx);
			ctx.ui.notify(`Permission mode: ${PERMISSION_MODE_INFO[newMode].label}`, "info");
		}
		return;
	}

	if (!hasInteractiveUI(ctx)) {
		ctx.ui.notify(
			`Current permission mode: ${PERMISSION_MODE_INFO[state.permissionMode].label} (${PERMISSION_MODE_INFO[state.permissionMode].desc})`,
			"info",
		);
		return;
	}

	const options = PERMISSION_MODES.map((mode) => {
		const info = PERMISSION_MODE_INFO[mode];
		const marker = mode === state.permissionMode ? " ← current" : "";
		return `${info.label}: ${info.desc}${marker}`;
	});

	const choice = await ctx.ui.select("Select permission mode", options);
	if (!choice) return;

	const selectedLabel = choice.split(":")[0].trim();
	const newMode = PERMISSION_MODES.find((m) => PERMISSION_MODE_INFO[m].label === selectedLabel);
	if (!newMode || newMode === state.permissionMode) return;

	const scope = await ctx.ui.select("Save to:", ["Session only", "Global (persists)"]);
	if (!scope) return;

	setMode(state, newMode, scope === "Global (persists)", ctx);
	const saveMsg = scope === "Global (persists)" ? " (saved globally)" : " (session only)";
	ctx.ui.notify(`Permission mode: ${PERMISSION_MODE_INFO[newMode].label}${saveMsg}`, "info");
}

/** Handle session_start - initialize level and show status */
export function handleSessionStart(state: PermissionState, ctx: any): void {
	// Check env var first (for print mode)
	const envLevel = process.env.PI_PERMISSION_LEVEL?.toLowerCase();
	if (envLevel) {
		// Support legacy env values too
		const legacyMap: Record<string, PermissionLevel> = {
			minimal: "read",
			low: "edit",
			medium: "auto",
			high: "auto",
			bypassed: "auto",
		};
		const mapped = legacyMap[envLevel] || (LEVELS.includes(envLevel as PermissionLevel) ? (envLevel as PermissionLevel) : null);
		if (mapped) {
			state.currentLevel = mapped;
		}
	} else {
		const globalLevel = loadGlobalPermission();
		if (globalLevel) {
			state.currentLevel = globalLevel;
		}
	}

	if (ctx.hasUI) {
		const globalMode = loadGlobalPermissionMode();
		if (globalMode) {
			state.permissionMode = globalMode;
		}
	}

	if (ctx.hasUI) {
		if (ctx.ui?.setStatus) {
			ctx.ui.setStatus("authority", getStatusText(state.currentLevel));
		}
		if (!isQuietMode(ctx)) {
			ctx.ui.notify(`Permission: ${LEVEL_INFO[state.currentLevel].label} (use /permission to change)`, "info");
		}
		if (state.permissionMode === "block") {
			ctx.ui.notify("Permission mode: Block (use /permission-mode to change)", "info");
		}
		const autoReviewModels = loadAutoReviewModels();
		if (state.currentLevel === "auto" && autoReviewModels.length > 0) {
			ctx.ui.notify(`Auto-review models: ${autoReviewModels.join(", ")}`, "info");
		}
	}
}

/** Handle bash tool_call - check permission and prompt if needed */
export async function handleBashToolCall(
	state: PermissionState,
	command: string,
	ctx: any,
): Promise<{ block: true; reason: string } | undefined> {
	const classification = classifyCommand(command);

	// Dangerous commands - always reviewed
	if (classification.dangerous) {
		if (!hasInteractiveUI(ctx)) {
			return {
				block: true,
				reason: `Dangerous command requires confirmation: ${command}\nConfigure autoReviewModels in settings.json to enable auto-review in non-interactive mode.`,
			};
		}

		if (state.permissionMode === "block") {
			return {
				block: true,
				reason: `Blocked by permission mode (block). Dangerous command: ${command}\nUse /permission-mode ask to enable confirmations.`,
			};
		}

		// In auto mode, try auto-review first
		if (state.currentLevel === "auto" && ctx.modelRegistry) {
			const review = await tryAutoReview(command, ctx.cwd, classification, ctx.modelRegistry, ctx.signal);
			if (review) {
				if (review.approved) {
					ctx.ui.notify(`🔓 Auto-approved by ${review.model}: ${review.rationale}`, "info");
					return undefined;
				} else {
					return { block: true, reason: `Auto-review denied by ${review.model}: ${review.rationale}` };
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

	// Check level
	const requiredIndex = LEVEL_INDEX[classification.level];
	const currentIndex = LEVEL_INDEX[state.currentLevel];

	if (requiredIndex > currentIndex) {
		const requiredLevel = classification.level;
		const requiredInfo = LEVEL_INFO[requiredLevel];

		// Print mode: block
		if (!hasInteractiveUI(ctx)) {
			return {
				block: true,
				reason: `Blocked by permission (${state.currentLevel}). Command: ${command}\nAllowed at this level: ${LEVEL_ALLOWED_DESC[state.currentLevel]}\nUser can re-run with: PI_PERMISSION_LEVEL=${requiredLevel} pi -p "..."`,
			};
		}

		if (state.permissionMode === "block") {
			return {
				block: true,
				reason: `Blocked by permission (${state.currentLevel}, mode: block). Command: ${command}\nRequires ${requiredInfo.label}. Allowed at this level: ${LEVEL_ALLOWED_DESC[state.currentLevel]}\nUse /permission ${requiredLevel} or /permission-mode ask to enable prompts.`,
			};
		}

		// Interactive mode: prompt to escalate level
		playPermissionSound();
		const choice = await ctx.ui.select(`Requires ${requiredInfo.label}`, ["Allow once", `Allow all (${requiredInfo.label})`, "Cancel"]);

		if (choice === "Allow once") return undefined;

		if (choice === `Allow all (${requiredInfo.label})`) {
			setLevel(state, requiredLevel, true, ctx);
			ctx.ui.notify(`Permission → ${requiredInfo.label} (saved globally)`, "info");
			return undefined;
		}

		return { block: true, reason: "Cancelled" };
	}

	// Level is satisfied, but check if auto-review is needed for high-risk commands
	if (classification.needsReview && state.currentLevel === "auto") {
		if (!hasInteractiveUI(ctx)) {
			return {
				block: true,
				reason: `High-risk command requires auto-review: ${command}\nConfigure autoReviewModels in settings.json to enable auto-review in non-interactive mode.`,
			};
		}

		if (state.permissionMode === "block") {
			return {
				block: true,
				reason: `Blocked by permission mode (block). High-risk command: ${command}`,
			};
		}

		// Try auto-review
		if (ctx.modelRegistry) {
			const review = await tryAutoReview(command, ctx.cwd, classification, ctx.modelRegistry, ctx.signal);
			if (review) {
				if (review.approved) {
					ctx.ui.notify(`🔓 Auto-approved by ${review.model}: ${review.rationale}`, "info");
					return undefined;
				} else {
					return { block: true, reason: `Auto-review denied by ${review.model}: ${review.rationale}` };
				}
			}
		}

		// No auto-review model available - prompt user
		playPermissionSound();
		const choice = await ctx.ui.select(`🔍 High-risk command (auto-review unavailable)`, ["Allow once", "Cancel"]);

		if (choice !== "Allow once") {
			return { block: true, reason: "Cancelled" };
		}
		return undefined;
	}

	return undefined;
}

/** Options for handleWriteToolCall */
export interface WriteToolCallOptions {
	state: PermissionState;
	toolName: string;
	filePath: string;
	ctx: any;
}

/** Handle read tool_call - scope file reads by cwd and sensitivity */
export async function handleReadToolCall(
	state: PermissionState,
	filePath: string,
	ctx: any,
): Promise<{ block: true; reason: string } | undefined> {
	const action = "Read";
	const target = inspectFileAccessTarget(filePath, ctx);

	if (!target.reviewReason) {
		return undefined;
	}

	// Non-safe file - need auto level
	if (state.currentLevel !== "auto") {
		const requiredInfo = LEVEL_INFO["auto"];

		if (!hasInteractiveUI(ctx)) {
			return {
				block: true,
				reason:
					`Blocked by permission (${state.currentLevel}). ${action}: ${filePath}\n` +
					`Resolved path: ${target.resolvedPath}\n` +
					`Reason: ${target.reviewReason}\n` +
					`Allowed at this level: ${LEVEL_ALLOWED_DESC[state.currentLevel]}\n` +
					`User can re-run with: PI_PERMISSION_LEVEL=auto pi -p "..."`,
			};
		}

		if (state.permissionMode === "block") {
			return {
				block: true,
				reason:
					`Blocked by permission (${state.currentLevel}, mode: block). ${action}: ${filePath}\n` +
					`Resolved path: ${target.resolvedPath}\n` +
					`Reason: ${target.reviewReason}\n` +
					`Requires ${requiredInfo.label}. Allowed at this level: ${LEVEL_ALLOWED_DESC[state.currentLevel]}\n` +
					`Use /permission auto or /permission-mode ask to enable prompts.`,
			};
		}

		playPermissionSound();
		const choice = await ctx.ui.select(
			`Requires ${requiredInfo.label}: ${action} ${filePath}`,
			["Allow once", "Approve and auto review", "Cancel"],
		);

		if (choice === "Allow once") {
			return undefined; // Human approved — skip auto-review
		}
		if (choice === "Approve and auto review") {
			setLevel(state, "auto", true, ctx);
			ctx.ui.notify(`Permission → ${requiredInfo.label} (saved globally)`, "info");
			// Fall through to auto-review below for this operation
		} else {
			return { block: true, reason: "Cancelled" };
		}
	}

	// In auto mode — try auto-review for non-safe files
	if (!hasInteractiveUI(ctx)) {
		return {
			block: true,
			reason:
				`Sensitive or out-of-scope file read requires auto-review: ${action} ${filePath}\n` +
				`Resolved path: ${target.resolvedPath}\n` +
				`Reason: ${target.reviewReason}\n` +
				`Configure autoReviewModels in settings.json to enable this in non-interactive mode.`,
		};
	}

	if (ctx.modelRegistry) {
		const review = await tryAutoReviewFileAccess(action, target.cwd, target.resolvedPath, target.reviewReason, ctx.modelRegistry, ctx.signal);
		if (review) {
			if (review.approved) {
				ctx.ui.notify(`🔓 Auto-approved by ${review.model}: ${review.rationale}`, "info");
				return undefined;
			}
			return { block: true, reason: `Auto-review denied by ${review.model}: ${review.rationale}` };
		}
	}

	if (state.permissionMode === "block") {
		return {
			block: true,
			reason:
				`Blocked by permission mode (block). ${action}: ${filePath}\n` +
				`Resolved path: ${target.resolvedPath}\n` +
				`Reason: ${target.reviewReason}\n` +
				`Auto-review was required but no review model returned a decision.`,
		};
	}

	playPermissionSound();
	const choice = await ctx.ui.select(`🔍 Auto-review required: ${action} ${filePath}`, ["Allow once", "Cancel"]);

	if (choice === "Allow once") {
		return undefined;
	}

	return { block: true, reason: "Cancelled" };
}

/** Handle write/edit tool_call - check permission and prompt if needed */
export async function handleWriteToolCall(opts: WriteToolCallOptions): Promise<{ block: true; reason: string } | undefined> {
	const { state, toolName, filePath, ctx } = opts;

	const action = toolName === "write" ? "Write" : "Edit";
	const target = inspectFileAccessTarget(filePath, ctx);
	const needsReview = Boolean(target.reviewReason);
	const requiredLevel: PermissionLevel = needsReview ? "auto" : "edit";
	let effectiveLevel = state.currentLevel;

	if (state.currentLevel === "read") {
		return {
			block: true,
			reason:
				`Blocked in Read mode. ${action}: ${filePath}\n` +
				`Resolved path: ${target.resolvedPath}\n` +
				`Read mode never permits file modifications. Use /permission edit or /permission auto before retrying.`,
		};
	}

	if (LEVEL_INDEX[effectiveLevel] < LEVEL_INDEX[requiredLevel]) {
		const requiredInfo = LEVEL_INFO[requiredLevel];

		if (!hasInteractiveUI(ctx)) {
			return {
				block: true,
				reason:
					`Blocked by permission (${state.currentLevel}). ${action}: ${filePath}\n` +
					`Resolved path: ${target.resolvedPath}\n` +
					(target.reviewReason ? `Reason: ${target.reviewReason}\n` : "") +
					`Allowed at this level: ${LEVEL_ALLOWED_DESC[state.currentLevel]}\n` +
					`User can re-run with: PI_PERMISSION_LEVEL=${requiredLevel} pi -p "..."`,
			};
		}

		if (state.permissionMode === "block") {
			return {
				block: true,
				reason:
					`Blocked by permission (${state.currentLevel}, mode: block). ${action}: ${filePath}\n` +
					`Resolved path: ${target.resolvedPath}\n` +
					(target.reviewReason ? `Reason: ${target.reviewReason}\n` : "") +
					`Requires ${requiredInfo.label}. Allowed at this level: ${LEVEL_ALLOWED_DESC[state.currentLevel]}\n` +
					`Use /permission ${requiredLevel} or /permission-mode ask to enable prompts.`,
			};
		}

		playPermissionSound();
		const choice = await ctx.ui.select(
			`Requires ${requiredInfo.label}: ${action} ${filePath}`,
			["Allow once", "Approve and auto review", "Cancel"],
		);

		if (choice === "Allow once") {
			return undefined; // Human approved — skip auto-review
		}
		if (choice === "Approve and auto review") {
			setLevel(state, requiredLevel, true, ctx);
			ctx.ui.notify(`Permission → ${requiredInfo.label} (saved globally)`, "info");
			// Fall through to auto-review below for this operation
		} else {
			return { block: true, reason: "Cancelled" };
		}
	}

	if (!needsReview) {
		return undefined;
	}

	if (effectiveLevel === "edit") {
		return {
			block: true,
			reason:
				`Blocked in Edit mode. ${action}: ${filePath}\n` +
				`Resolved path: ${target.resolvedPath}\n` +
				`Reason: ${target.reviewReason}\n` +
				`Edit mode only auto-allows non-sensitive files inside ${target.cwd}. Use /permission auto to enable auto-review for this request.`,
		};
	}

	if (!hasInteractiveUI(ctx)) {
		return {
			block: true,
			reason:
				`Sensitive or out-of-scope file edit requires auto-review: ${action} ${filePath}\n` +
				`Resolved path: ${target.resolvedPath}\n` +
				`Reason: ${target.reviewReason}\n` +
				`Configure autoReviewModels in settings.json to enable this in non-interactive mode.`,
		};
	}

	if (ctx.modelRegistry) {
		const review = await tryAutoReviewFileAccess(action, target.cwd, target.resolvedPath, target.reviewReason!, ctx.modelRegistry, ctx.signal);
		if (review) {
			if (review.approved) {
				ctx.ui.notify(`🔓 Auto-approved by ${review.model}: ${review.rationale}`, "info");
				return undefined;
			}
			return { block: true, reason: `Auto-review denied by ${review.model}: ${review.rationale}` };
		}
	}

	if (state.permissionMode === "block") {
		return {
			block: true,
			reason:
				`Blocked by permission mode (block). ${action}: ${filePath}\n` +
				`Resolved path: ${target.resolvedPath}\n` +
				`Reason: ${target.reviewReason}\n` +
				`Auto-review was required but no review model returned a decision.`,
		};
	}

	playPermissionSound();
	const choice = await ctx.ui.select(`🔍 Auto-review required: ${action} ${filePath}`, ["Allow once", "Cancel"]);

	if (choice === "Allow once") {
		return undefined;
	}

	return { block: true, reason: "Cancelled" };
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function (pi: ExtensionAPI) {
	const state = createInitialState();

	pi.registerCommand("permission", {
		description: "View or change permission level",
		handler: (args, ctx) => handlePermissionCommand(state, args, ctx),
	});

	pi.registerCommand("permission-mode", {
		description: "Set permission prompt mode (ask or block)",
		handler: (args, ctx) => handlePermissionModeCommand(state, args, ctx),
	});

	pi.on("session_start", async (_event, ctx) => {
		handleSessionStart(state, ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") {
			return handleBashToolCall(state, event.input.command as string, ctx);
		}

		if (event.toolName === "read") {
			return handleReadToolCall(state, event.input.path as string, ctx);
		}

		if (event.toolName === "write" || event.toolName === "edit") {
			return handleWriteToolCall({
				state,
				toolName: event.toolName,
				filePath: event.input.path as string,
				ctx,
			});
		}

		return undefined;
	});
}
