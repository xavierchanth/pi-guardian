import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  parseWorkContextDetails,
  type WorkContextSnapshot,
} from "./domain.ts";

export const UPDATE_PLAN_TOOL_NAME = "update_plan";

export interface WorkContextStore {
  current(): WorkContextSnapshot | undefined;
  replace(snapshot: WorkContextSnapshot): void;
  reconstruct(ctx: ExtensionContext): WorkContextSnapshot | undefined;
}

export function createPiSessionWorkContextStore(): WorkContextStore {
  let state: WorkContextSnapshot | undefined;
  return {
    current: () => state,
    replace(snapshot) {
      state = snapshot;
    },
    reconstruct(ctx) {
      state = latestWorkContext(ctx.sessionManager.getBranch());
      return state;
    },
  };
}

export function latestWorkContext(
  branch: readonly unknown[],
): WorkContextSnapshot | undefined {
  let latest: WorkContextSnapshot | undefined;
  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message) || message.role !== "toolResult") continue;
    if (message.toolName !== UPDATE_PLAN_TOOL_NAME) continue;
    const parsed = parseWorkContextDetails(message.details);
    if (parsed) latest = parsed;
  }
  return latest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
