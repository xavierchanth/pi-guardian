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
import { reviewAction, type ReviewRequest, type ReviewResult } from "./reviewer.ts";
import { GUARDIAN_REVIEW_FAILED_EVENT } from "../../terminal/notifications/events.ts";
import {
  isDestructiveCandidate,
  preflightManagedSubagentCleanup,
  type ProposedAction,
  type ReviewDecision,
} from "./policy.ts";
import { createGuardianReviewRecorder, type GuardianReviewRecorder } from "./records.ts";

export type ActionReviewer = (request: ReviewRequest) => Promise<ReviewResult>;

export interface HumanExecutionRequiredNotice {
  action: ProposedAction;
  reason: string;
  decision?: ReviewDecision;
  reviewUnavailable: boolean;
}

export interface GuardianOptions {
  reviewer?: ActionReviewer;
  recorder?: GuardianReviewRecorder;
  delegationStoreRoot?: string;
  onHumanExecutionRequired?: (notice: HumanExecutionRequiredNotice) => void | Promise<void>;
}

export function registerApprovalGuardian(pi: ExtensionAPI, options: GuardianOptions = {}): void {
  const reviewer = options.reviewer ?? reviewAction;
  const recorder = options.recorder ?? createGuardianReviewRecorder();

  pi.on("tool_call", async (event, ctx) => {
    let reviewEvidence: PathReviewEvidence | undefined;
    if (event.toolName === "bash") {
      const cleanupDecision = await preflightManagedSubagentCleanup(
        event.input as Record<string, unknown>,
        ctx.cwd,
        options.delegationStoreRoot,
      );
      if (cleanupDecision.kind === "allow") return undefined;
      // Non-runtime deletion forms still receive the task-aware model review below.
    }
    if (FILE_TOOL_NAMES.has(event.toolName) && isBuiltinTool(pi, event.toolName)) {
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
        toolName: action.toolName,
        reason: result.reason,
        cwd: ctx.cwd,
      });
    }
    if (result.kind !== "decision") {
      if (!isDestructiveCandidate(action)) return undefined;
      await notifyHumanExecutionRequired(options, {
        action,
        reason: result.reason,
        reviewUnavailable: true,
      });
      return { block: true, reason: humanExecutionReason(action, result.reason, true) };
    }
    if (result.decision.outcome === "human_execution_required") {
      await notifyHumanExecutionRequired(options, {
        action,
        reason: result.decision.reason,
        decision: result.decision,
        reviewUnavailable: false,
      });
      return { block: true, reason: humanExecutionReason(action, result.decision.reason, false) };
    }
    return { block: true, reason: denialReason(result.decision.reason) };
  });
}

function isBuiltinTool(pi: ExtensionAPI, toolName: string): boolean {
  return pi.getAllTools().find((tool) => tool.name === toolName)?.sourceInfo.source === "builtin";
}

function collectConversation(ctx: ExtensionContext): unknown[] {
  return ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
}

async function notifyHumanExecutionRequired(
  options: GuardianOptions,
  notice: HumanExecutionRequiredNotice,
): Promise<void> {
  try {
    await options.onHumanExecutionRequired?.(notice);
  } catch {
    // The dangerous action remains blocked even if escalation delivery fails.
  }
}

function humanExecutionReason(
  action: ProposedAction,
  reason: string,
  reviewUnavailable: boolean,
): string {
  const exactAction =
    action.toolName === "bash" && typeof action.arguments.command === "string"
      ? `Command for the human to review and run directly if they choose:\n${action.arguments.command}`
      : `Tool action for the human to review and perform directly if they choose:\n${JSON.stringify({ tool: action.toolName, arguments: action.arguments })}`;
  const basis = reviewUnavailable
    ? `Guardian could not complete review of a potentially destructive action: ${reason}`
    : `Guardian classified this as high-risk and will not execute it: ${reason}`;
  return `${basis.replace(/[.\s]+$/g, "")}. The action was not executed. Do not retry it, delegate it, or ask another agent to execute it. Surface this notice unchanged to the top-level user. ${exactAction}`;
}

function denialReason(reason: string): string {
  return `Guardian denied an unrelated or unclear high-risk action: ${reason.replace(/[.\s]+$/g, "")}. The action was not executed. Do not retry, delegate, or provide a runnable command; continue with safe task work.`;
}

function autonomousBlockReason(reason: string): string {
  return `${reason.replace(/[.\s]+$/g, "")}. The action was not executed; continue with other authorized work without asking the user to approve it.`;
}
