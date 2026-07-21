import {
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { canonicalizeCwd, checkFileToolPath, FILE_TOOL_NAMES } from "./paths.ts";
import { reviewAction, type ReviewRequest, type ReviewResult } from "./reviewer.ts";
import type { WorkContextSnapshot } from "../work-context/domain.ts";

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
    if (FILE_TOOL_NAMES.has(event.toolName) && isBuiltinTool(pi, event.toolName)) {
      const decision = await checkFileToolPath(
        event.toolName,
        event.input as Record<string, unknown>,
        ctx.cwd,
      );
      return decision.allowed
        ? undefined
        : { block: true, reason: decision.reason ?? "File tool target is outside allowed boundaries." };
    }
    if (event.toolName !== "bash") return undefined;

    let result: ReviewResult;
    try {
      const cwd = await canonicalizeCwd(ctx.cwd);
      result = await reviewer({
        modelRegistry: ctx.modelRegistry,
        cwd,
        messages: collectConversation(ctx),
        workContext: options.workContext?.(),
        action: {
          toolName: event.toolName,
          arguments: event.input as Record<string, unknown>,
          cwd,
        },
        signal: ctx.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { kind: "failure", reason: `Automatic action review failed: ${message}` };
    }

    if (result.kind === "decision" && result.decision.outcome === "allow") return undefined;
    if (result.kind !== "cancelled" && ctx.mode === "tui") {
      const exactAction = JSON.stringify({
        toolName: event.toolName,
        arguments: event.input,
        cwd: await canonicalizeCwd(ctx.cwd),
      }, null, 2);
      const choice = await ctx.ui.select(
        `Automatic review did not allow this exact action:\n\n${exactAction}`,
        ["Allow exact action once", "Cancel"],
      );
      if (choice === "Allow exact action once") return undefined;
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
    return `Action denied by automatic review: ${result.decision.reason}`;
  }
  return `Action blocked because ${result.reason}`;
}
