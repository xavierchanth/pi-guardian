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
import type { WorkContextSnapshot } from "../work-context/domain.ts";
import {
  GUARDIAN_CONFIRMATION_REQUIRED_EVENT,
  GUARDIAN_REVIEW_FAILED_EVENT,
} from "../notifications/events.ts";

export type ActionReviewer = (request: ReviewRequest) => Promise<ReviewResult>;

export interface GuardianOptions {
  reviewer?: ActionReviewer;
  workContext?: () => WorkContextSnapshot | undefined;
}

export function registerApprovalGuardian(
  pi: ExtensionAPI,
  options: GuardianOptions = {},
): void {
  const reviewer = options.reviewer ?? reviewAction;

  pi.on("tool_call", async (event, ctx) => {
    let reviewEvidence: PathReviewEvidence | undefined;
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
          reason: pathDecision.reason ?? "File tool target is outside allowed boundaries.",
        };
      }
      reviewEvidence = pathDecision.evidence;
    } else if (event.toolName !== "bash") {
      return undefined;
    }

    let result: ReviewResult;
    let canonicalCwd: string;
    try {
      canonicalCwd = await canonicalizeCwd(ctx.cwd);
      result = await reviewer({
        modelRegistry: ctx.modelRegistry,
        cwd: canonicalCwd,
        messages: collectConversation(ctx),
        workContext: options.workContext?.(),
        reviewEvidence,
        action: {
          toolName: event.toolName,
          arguments: event.input as Record<string, unknown>,
          cwd: canonicalCwd,
        },
        signal: ctx.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { kind: "failure", reason: `Automatic action review failed: ${message}` };
      canonicalCwd = ctx.cwd;
    }

    if (result.kind === "decision") {
      if (result.decision.outcome === "allow") return undefined;
      if (result.decision.outcome === "deny") {
        return { block: true, reason: blockReason(result) };
      }
      return confirmExactAction(pi, event, ctx, canonicalCwd, result);
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

async function confirmExactAction(
  pi: ExtensionAPI,
  event: { toolName: string; input: unknown },
  ctx: ExtensionContext,
  cwd: string,
  result: Extract<ReviewResult, { kind: "decision" }>,
): Promise<{ block: true; reason: string } | undefined> {
  if (ctx.mode !== "tui") {
    return {
      block: true,
      reason: `Action requires interactive user confirmation: ${result.decision.reason}`,
    };
  }

  pi.events.emit(GUARDIAN_CONFIRMATION_REQUIRED_EVENT, {
    mode: ctx.mode,
    riskLevel: result.decision.riskLevel,
  });
  const exactAction = JSON.stringify({
    toolName: event.toolName,
    arguments: event.input,
    cwd,
  }, null, 2);
  try {
    const choice = await ctx.ui.select(
      `Guardian requests your review: ${result.decision.reason}\n\n${exactAction}`,
      ["Execute exact action once", "Deny"],
    );
    if (choice === "Execute exact action once") return undefined;
    return { block: true, reason: "Action denied by user after Guardian requested confirmation." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { block: true, reason: `Action blocked because confirmation failed: ${message}` };
  }
}

function isBuiltinTool(pi: ExtensionAPI, toolName: string): boolean {
  return pi.getAllTools().find((tool) => tool.name === toolName)?.sourceInfo.source === "builtin";
}

function collectConversation(ctx: ExtensionContext): unknown[] {
  return ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
}

function blockReason(result: ReviewResult): string {
  if (result.kind === "decision") {
    return `Action denied by automatic review: ${result.decision.reason}`;
  }
  return `Action blocked because ${result.reason}`;
}
