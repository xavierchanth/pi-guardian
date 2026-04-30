import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { GuardianModeDefinition, GuardianModeId, GuardianReviewMode } from "./mode-framework";

export interface PermissionState {
	currentMode: GuardianModeId;
	isSessionOnly: boolean;
	reviewMode: GuardianReviewMode;
	isReviewModeSessionOnly: boolean;
}

export interface ToolBlockResult {
	block: true;
	reason: string;
}

export type ToolHandlerResult = ToolBlockResult | undefined;

export interface GuardianModeToolContext {
	state: PermissionState;
	ctx: any;
	pi: ExtensionAPI;
}

export interface GuardianModeHandlerFactoryDeps {
	onBash: (mode: GuardianModeId, input: string, context: GuardianModeToolContext) => Promise<ToolHandlerResult>;
	onRead: (mode: GuardianModeId, input: string, context: GuardianModeToolContext) => Promise<ToolHandlerResult>;
	onWrite: (
		mode: GuardianModeId,
		toolName: "write" | "edit",
		input: string,
		context: GuardianModeToolContext,
	) => Promise<ToolHandlerResult>;
}

export type GuardianRegisteredMode = GuardianModeDefinition<PermissionState, any, ExtensionAPI, ToolHandlerResult>;
