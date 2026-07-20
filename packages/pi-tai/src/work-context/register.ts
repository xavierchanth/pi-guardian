import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  PLAN_PRIORITIES,
  PLAN_STATUSES,
  formatWorkContext,
  parseWorkContextDetails,
  validateWorkContextUpdate,
  workContextDetails,
  type WorkContextSnapshot,
} from "./domain.ts";
import {
  UPDATE_PLAN_TOOL_NAME,
  createPiSessionWorkContextStore,
  type WorkContextStore,
} from "./persistence.ts";
import {
  collapsedWorkContextText,
  fullWorkContextText,
  workContextStatusLines,
} from "./presentation.ts";

const WORK_CONTEXT_WIDGET_ID = "pi-tai-work-context";

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

class WorkContextWidget {
  private readonly snapshot: WorkContextSnapshot;
  private readonly theme: Theme;

  constructor(snapshot: WorkContextSnapshot, theme: Theme) {
    this.snapshot = snapshot;
    this.theme = theme;
  }

  render(width: number): string[] {
    const [goalLine, planLine] = workContextStatusLines(this.snapshot);
    return [
      truncateToWidth(
        this.theme.fg("accent", this.theme.bold("Goal:")) +
          this.theme.fg("muted", goalLine.slice("Goal:".length)),
        Math.max(1, width),
      ),
      truncateToWidth(
        this.theme.fg("accent", this.theme.bold("Plan:")) +
          this.theme.fg("muted", planLine.slice("Plan:".length)),
        Math.max(1, width),
      ),
    ];
  }

  invalidate(): void {}
}

class PlanStatusView {
  private readonly text: Text;
  private readonly close: () => void;

  constructor(
    snapshot: WorkContextSnapshot,
    theme: Theme,
    close: () => void,
  ) {
    this.close = close;
    this.text = new Text(
      [
        theme.fg("accent", theme.bold("Plan Status")),
        "",
        fullWorkContextText(snapshot),
        "",
        theme.fg("dim", "Press Escape, Enter, or Ctrl+C to close"),
      ].join("\n"),
      1,
      1,
    );
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "return") ||
      matchesKey(data, "ctrl+c")
    ) {
      this.close();
    }
  }

  render(width: number): string[] {
    return this.text.render(width);
  }

  invalidate(): void {
    this.text.invalidate();
  }
}

export function registerWorkContext(
  pi: ExtensionAPI,
  store: WorkContextStore = createPiSessionWorkContextStore(),
): WorkContextStore {
  const refreshWidget = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    const snapshot = store.current();
    if (!snapshot) {
      ctx.ui.setWidget(WORK_CONTEXT_WIDGET_ID, undefined);
      return;
    }
    ctx.ui.setWidget(
      WORK_CONTEXT_WIDGET_ID,
      (_tui, theme) => new WorkContextWidget(snapshot, theme),
      { placement: "belowEditor" },
    );
  };

  const reconstruct = (_event: unknown, ctx: ExtensionContext): void => {
    store.reconstruct(ctx);
    refreshWidget(ctx);
  };
  pi.on("session_start", reconstruct);
  pi.on("session_tree", reconstruct);
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setWidget(WORK_CONTEXT_WIDGET_ID, undefined);
  });

  pi.registerCommand("plan-status", {
    description: "Show the current goal and complete plan",
    handler: async (_args, ctx) => {
      const snapshot = store.current();
      if (!snapshot) {
        ctx.ui.notify("No active work context.", "info");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/plan-status requires interactive TUI mode.", "error");
        return;
      }
      await ctx.ui.custom<void>((_tui, theme, _keybindings, done) =>
        new PlanStatusView(snapshot, theme, () => done()),
      );
    },
  });

  pi.registerTool({
    name: UPDATE_PLAN_TOOL_NAME,
    label: "Update Plan",
    description:
      "Create or replace structured work context for a task with multiple meaningful steps. Provide the current goal and complete plan; at most one item may be in_progress, and an item must be in_progress before completed.",
    promptSnippet: "Maintain structured work context for multi-step tasks",
    promptGuidelines: [
      "Use update_plan before substantial work when a task has multiple meaningful steps or needs progress tracking.",
      "Call update_plan after completing the active step, materially changing scope or sequence, or discovering additional work; send the complete replacement goal and plan every time.",
      "Keep exactly one update_plan step in_progress while planned work remains, and move an item through in_progress before completed.",
      "Do not use update_plan for simple one-step requests that can be completed immediately.",
    ],
    parameters: UpdatePlanSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const snapshot = validateWorkContextUpdate(params, store.current());
      store.replace(snapshot);
      refreshWidget(ctx);
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
    renderResult(result, { expanded }, theme) {
      const snapshot = parseWorkContextDetails(result.details);
      if (!snapshot) {
        return new Text(
          theme.fg("error", "Invalid work-context result"),
          0,
          0,
        );
      }
      return new Text(
        expanded
          ? fullWorkContextText(snapshot)
          : theme.fg("success", collapsedWorkContextText(snapshot)),
        0,
        0,
      );
    },
  });

  return store;
}
