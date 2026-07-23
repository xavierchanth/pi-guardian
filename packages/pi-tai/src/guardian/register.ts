import {
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  canonicalizeCwd,
  checkFileToolPath,
  FILE_TOOL_NAMES,
  type PathReviewEvidence,
} from "./paths.ts";
import {
  WEB_FETCH_TOOL_NAME,
  preflightWebFetch,
  type WebFetchReviewEvidence,
} from "../web/domain.ts";
import { reviewAction, type ReviewRequest, type ReviewResult } from "./reviewer.ts";
import type { WorkContextSnapshot } from "../work-context/domain.ts";
import { GUARDIAN_REVIEW_FAILED_EVENT } from "../notifications/events.ts";
import { preflightManagedSubagentCleanup } from "./policy.ts";
import {
  createGuardianReviewRecorder,
  type GuardianReviewRecorder,
} from "./records.ts";

export type ActionReviewer = (request: ReviewRequest) => Promise<ReviewResult>;

export interface GuardianOptions {
  reviewer?: ActionReviewer;
  recorder?: GuardianReviewRecorder;
  workContext?: () => WorkContextSnapshot | undefined;
  delegationStoreRoot?: string;
}

export function registerApprovalGuardian(
  pi: ExtensionAPI,
  options: GuardianOptions = {},
): void {
  const reviewer = options.reviewer ?? reviewAction;
  const recorder = options.recorder ?? createGuardianReviewRecorder();

  pi.on("tool_call", async (event, ctx) => {
    let reviewEvidence: PathReviewEvidence | WebFetchReviewEvidence | undefined;
    if (event.toolName === "bash") {
      const cleanupDecision = await preflightManagedSubagentCleanup(
        event.input as Record<string, unknown>,
        ctx.cwd,
        options.delegationStoreRoot,
      );
      if (cleanupDecision.kind === "allow") return undefined;
      if (cleanupDecision.kind === "deny") {
        return { block: true, reason: autonomousBlockReason(cleanupDecision.reason) };
      }
    }
    if (event.toolName === WEB_FETCH_TOOL_NAME) {
      const networkDecision = preflightWebFetch(event.input as Record<string, unknown>);
      if (networkDecision.kind === "deny") {
        return {
          block: true,
          reason: autonomousBlockReason(networkDecision.reason),
        };
      }
      reviewEvidence = networkDecision.evidence;
    } else if (FILE_TOOL_NAMES.has(event.toolName) && isBuiltinTool(pi, event.toolName)) {
      const pathDecision = await checkFileToolPath(
        event.toolName,
        event.input as Record<string, unknown>,
        ctx.cwd,
      );
      if (pathDecision.kind === "allow") return undefined;
      if (pathDecision.kind === "deny") {
        return {
          block: true,
          reason: autonomousBlockReason(
            pathDecision.reason ?? "File tool target is outside allowed boundaries.",
          ),
        };
      }
      reviewEvidence = pathDecision.evidence;
    } else if (event.toolName !== "bash") {
      return undefined;
    }

    let result: ReviewResult;
    let canonicalCwd: string;
    const messages = collectConversation(ctx);
    const workContext = options.workContext?.();
    let action: ReviewRequest["action"];
    try {
      canonicalCwd = await canonicalizeCwd(ctx.cwd);
      action = {
        toolName: event.toolName,
        arguments: event.input as Record<string, unknown>,
        cwd: canonicalCwd,
      };
      result = await reviewer({
        modelRegistry: ctx.modelRegistry,
        cwd: canonicalCwd,
        messages,
        workContext,
        reviewEvidence,
        action,
        signal: ctx.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { kind: "failure", reason: `Automatic action review failed: ${message}` };
      canonicalCwd = ctx.cwd;
      action = {
        toolName: event.toolName,
        arguments: event.input as Record<string, unknown>,
        cwd: canonicalCwd,
      };
    }

    if (result.kind === "decision" && result.decision.outcome === "allow") return undefined;
    try {
      await recorder({
        result,
        action,
        messages,
        workContext,
        reviewEvidence,
        mode: ctx.mode,
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
      });
    } catch {
      // Evaluation capture must never interrupt the surrounding agent run.
    }

    if (result.kind === "failure" || result.kind === "timeout") {
      pi.events.emit(GUARDIAN_REVIEW_FAILED_EVENT, {
        kind: result.kind,
        mode: ctx.mode,
      });
    }
    return { block: true, reason: blockReason(result) };
  });
}

function isBuiltinTool(pi: ExtensionAPI, toolName: string): boolean {
  return pi.getAllTools().find((tool) => tool.name === toolName)?.sourceInfo.source === "builtin";
}

function collectConversation(ctx: ExtensionContext): unknown[] {
  return ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
}

function blockReason(result: ReviewResult): string {
  if (result.kind === "decision") {
    return autonomousBlockReason(`Action denied by automatic review: ${result.decision.reason}`);
  }
  return autonomousBlockReason(`Action blocked because ${result.reason}`);
}

function autonomousBlockReason(reason: string): string {
  return `${reason.replace(/[.\s]+$/g, "")}. The action was not executed; continue with other authorized work without asking the user to approve it.`;
}
