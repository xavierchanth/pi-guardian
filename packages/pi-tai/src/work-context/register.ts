import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  PLAN_PRIORITIES,
  PLAN_STATUSES,
  formatWorkContext,
  validateWorkContextUpdate,
  workContextDetails,
  type WorkContextDetails,
} from "./domain.ts";
import {
  UPDATE_PLAN_TOOL_NAME,
  createPiSessionWorkContextStore,
  type WorkContextStore,
} from "./persistence.ts";

const PlanItemSchema = Type.Object({
  content: Type.String({ description: "Concise plan step" }),
  status: StringEnum(PLAN_STATUSES),
  priority: Type.Optional(StringEnum(PLAN_PRIORITIES)),
});

export const UpdatePlanSchema = Type.Object({
  goal: Type.String({ description: "Current north-star goal" }),
  explanation: Type.Optional(Type.String({ description: "Why the plan changed" })),
  plan: Type.Array(PlanItemSchema, {
    description: "Complete replacement plan; use an empty list for simple work",
  }),
});

export type UpdatePlanInput = Static<typeof UpdatePlanSchema>;

export function registerWorkContext(
  pi: ExtensionAPI,
  store: WorkContextStore = createPiSessionWorkContextStore(),
): WorkContextStore {
  const reconstruct = (_event: unknown, ctx: Parameters<WorkContextStore["reconstruct"]>[0]) => {
    store.reconstruct(ctx);
  };
  pi.on("session_start", reconstruct);
  pi.on("session_tree", reconstruct);

  pi.registerTool({
    name: UPDATE_PLAN_TOOL_NAME,
    label: "Update Plan",
    description:
      "Replace the current work goal and complete plan. At most one item may be in_progress, and an item must be in_progress before completed.",
    promptSnippet: "Maintain structured work context for multi-step tasks",
    promptGuidelines: [
      "Use update_plan for multi-step work, keep exactly one step in_progress while work remains, and send the complete replacement plan on every update.",
      "Do not use update_plan for simple one-step requests that can be completed immediately.",
    ],
    parameters: UpdatePlanSchema,
    async execute(_toolCallId, params) {
      const snapshot = validateWorkContextUpdate(params, store.current());
      store.replace(snapshot);
      return {
        content: [{ type: "text" as const, text: formatWorkContext(snapshot) }],
        details: workContextDetails(snapshot),
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("update_plan ")) +
          theme.fg("muted", args.goal),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as WorkContextDetails | undefined;
      if (!details) return new Text(theme.fg("error", "Invalid work-context result"), 0, 0);
      const complete = details.plan.filter((item) => item.status === "completed").length;
      return new Text(
        theme.fg("success", "✓ Plan updated ") +
          theme.fg("muted", `${complete}/${details.plan.length} complete`),
        0,
        0,
      );
    },
  });

  return store;
}
