import type { GuardianModeId, GuardianReviewMode } from "./mode-framework";

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
