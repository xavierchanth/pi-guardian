import path from "node:path";
import { classifyCommand, LEVEL_INDEX, type Classification, type PermissionLevel } from "./permission-core";
import type { BashToolPolicy, ReadToolPolicy, ToolAccessDecision, WriteToolPolicy } from "./access-policy";
import type { GuardianModeId } from "./mode-framework";

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

export interface FileAccessTarget {
	cwd: string;
	resolvedPath: string;
	withinCwd: boolean;
	reviewReason?: string;
}

function resolveTargetPath(filePath: string, cwd: string): string {
	if (path.isAbsolute(filePath)) return path.normalize(filePath);
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

export function inspectFileAccessTarget(filePath: string, cwd: string): FileAccessTarget {
	const resolvedPath = resolveTargetPath(filePath, cwd);
	const withinCwd = isPathWithinDirectory(cwd, resolvedPath);
	const sensitiveReason = getSensitivePathReason(resolvedPath);
	const reviewReason = !withinCwd ? `target is outside the current working directory (${cwd})` : sensitiveReason;
	return { cwd, resolvedPath, withinCwd, reviewReason };
}

function applySensitiveBehavior(behavior: ReadToolPolicy["sensitiveAccess"], reviewReason: string): ToolAccessDecision {
	switch (behavior) {
		case "allow":
			return { decision: "allow" };
		case "deny":
			return { decision: "deny", reason: reviewReason };
		case "prompt-upgrade-auto":
			return { decision: "prompt-upgrade", targetMode: "auto", reason: reviewReason };
		case "review-in-auto":
			return { decision: "review", reviewReason };
	}
}

export function evaluateBashAccess(policy: BashToolPolicy, command: string): ToolAccessDecision & { classification: Classification } {
	const classification = classifyCommand(command);
	if (classification.dangerous) {
		if (policy.allowDangerous === "review-in-auto") {
			return { decision: "review", reviewReason: `Dangerous command: ${command}`, classification };
		}
		return { decision: "deny", reason: `Dangerous command: ${command}`, classification };
	}

	if (LEVEL_INDEX[classification.level] > LEVEL_INDEX[policy.maxCommandLevel]) {
		return {
			decision: "prompt-upgrade",
			targetMode: classification.level as GuardianModeId,
			reason: `Command requires ${classification.level} access`,
			classification,
		};
	}

	if (classification.needsReview && policy.highRisk === "review-in-auto") {
		return { decision: "review", reviewReason: `High-risk command: ${command}`, classification };
	}

	return { decision: "allow", classification };
}

export function evaluateReadAccess(policy: ReadToolPolicy, filePath: string, cwd: string): ToolAccessDecision & { target: FileAccessTarget } {
	const target = inspectFileAccessTarget(filePath, cwd);
	if (!target.reviewReason) return { decision: "allow", target };
	return { ...applySensitiveBehavior(policy.sensitiveAccess, target.reviewReason), target };
}

function extensionAllowed(filePath: string, allowedExtensions: string[] | undefined): boolean {
	if (!allowedExtensions || allowedExtensions.length === 0) return true;
	const ext = path.extname(filePath).toLowerCase();
	return allowedExtensions.map((value) => value.toLowerCase()).includes(ext);
}

export function evaluateWriteAccess(
	policy: WriteToolPolicy,
	filePath: string,
	cwd: string,
): ToolAccessDecision & { target: FileAccessTarget } {
	const target = inspectFileAccessTarget(filePath, cwd);
	if (!policy.allow) {
		return { decision: "deny", reason: "This mode does not permit file modifications.", target };
	}
	if (!extensionAllowed(target.resolvedPath, policy.allowedExtensions)) {
		return {
			decision: "deny",
			reason: `This mode only permits edits to: ${(policy.allowedExtensions ?? []).join(", ")}`,
			target,
		};
	}
	if (!target.reviewReason) return { decision: "allow", target };
	return { ...applySensitiveBehavior(policy.sensitiveAccess, target.reviewReason), target };
}

export function canModeSatisfy(targetMode: GuardianModeId, requiredLevel: PermissionLevel): boolean {
	if (requiredLevel === "read") return true;
	if (requiredLevel === "edit") return targetMode === "edit" || targetMode === "auto";
	return targetMode === "auto";
}
