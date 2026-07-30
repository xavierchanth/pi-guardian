import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SessionCapabilityController } from "../../packages/pi-tai/src/capabilities/controller.ts";
import { registerFooter } from "../../packages/pi-tai/src/footer/register.ts";
import {
  footerRowText,
  formatWorkspacePath,
  renderFooterRows,
  type FooterSnapshot,
} from "../../packages/pi-tai/src/footer/render.ts";
import type { WorkContextStore } from "../../packages/pi-tai/src/work-context/persistence.ts";

const snapshot: FooterSnapshot = {
  cwd: "/home/example/projects/pi-tai",
  capabilities: ["subagents"],
  goal: "Ship a focused three-row footer",
  currentStep: "Implement layout and truncation",
  currentStepNumber: 2,
  totalSteps: 3,
  usage: {
    input: 465_000,
    output: 35_000,
    cacheRead: 7_200_000,
    cacheWrite: 0,
    cost: 6.991,
  },
  contextWindow: 272_000,
  contextPercent: 67.6,
  usingSubscription: true,
  model: "gpt-5.6-sol",
  reasoning: true,
  thinkingLevel: "low",
};

test("renders the requested three-row work-focused footer", () => {
  const rows = renderFooterRows(snapshot, 100);
  const lines = rows.map(footerRowText);

  assert.equal(lines.length, 3);
  assert.ok(lines[0]?.startsWith("Goal: Ship a focused three-row footer"));
  assert.ok(lines[0]?.endsWith("gpt-5.6-sol · low"));
  assert.ok(lines[1]?.startsWith("2/3: Implement layout and truncation"));
  assert.ok(lines[1]?.endsWith("67.6%/272k (auto)"));
  assert.ok(lines[2]?.startsWith("projects/pi-tai · subagents"));
  assert.ok(lines[2]?.endsWith("↑465k ↓35k R7.2M $6.991 (sub)"));
  assert.deepEqual(
    rows.map((row) => row.leftColor),
    ["text", "text", "text"],
  );
  for (const line of lines) assert.equal(visibleWidth(line), 100);
});

test("renders the Goal label exactly once when stored context already has it", () => {
  const [row] = renderFooterRows({ ...snapshot, goal: "Goal: Ship it" }, 80);

  assert.ok(row);
  assert.ok(footerRowText(row).startsWith("Goal: Ship it"));
  assert.ok(!footerRowText(row).startsWith("Goal: Goal:"));
});

test("truncates long goals and steps while preserving right-side status", () => {
  const rows = renderFooterRows(
    {
      ...snapshot,
      goal: "A very long main goal that cannot possibly fit into a narrow terminal footer",
      currentStep: "A similarly long current step that should be truncated cleanly",
    },
    48,
  );
  const lines = rows.map(footerRowText);

  assert.ok(lines[0]?.endsWith("gpt-5.6-sol · low"));
  assert.ok(lines[1]?.endsWith("67.6%/272k (auto)"));
  assert.ok(lines[0]?.includes("..."));
  assert.ok(lines[1]?.includes("..."));
  for (const line of lines) assert.equal(visibleWidth(line), 48);
});

test("shows exactly the parent and current workspace path segments", () => {
  assert.equal(formatWorkspacePath("/home/example/projects/pi-tai"), "projects/pi-tai");
  assert.equal(formatWorkspacePath("/tmp/project"), "tmp/project");
});

test("renders enabled capability labels beside the directory with base foreground", async () => {
  const handlers = new Map<string, (event: unknown, ctx: any) => void>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: any) => void) {
      handlers.set(event, handler);
    },
    getThinkingLevel: () => "low",
  } as unknown as ExtensionAPI;
  const workContext: WorkContextStore = {
    current: () => ({
      goal: "Main goal",
      plan: [{ content: "Current step", status: "in_progress" as const }],
    }),
    replace() {},
    reconstruct: () => undefined,
  };
  const capabilities = new SessionCapabilityController();
  capabilities.register({ id: "subagents", label: "Subagents", description: "Delegate work" });
  await capabilities.enable("subagents", { owner: "user", exposure: "model-tools" });
  registerFooter(pi, workContext, capabilities);

  let factory: ((tui: any, theme: any, footerData: any) => any) | undefined;
  const ctx = {
    mode: "tui",
    cwd: "/tmp/project",
    model: undefined,
    modelRegistry: { isUsingOAuth: () => false },
    sessionManager: {
      getEntries: () => [
        {
          type: "custom",
          customType: "pi-tai-subagent-role",
          data: { mode: "root", agentName: "subagents" },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: { total: 0.1 } },
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.2 } },
          },
        },
      ],
    },
    getContextUsage: () => undefined,
    ui: {
      setFooter(value: typeof factory) {
        factory = value;
      },
    },
  };
  handlers.get("session_start")?.({}, ctx);
  assert.ok(factory);

  const colors: string[] = [];
  const footer = factory(
    {},
    {
      fg(color: string, text: string) {
        colors.push(color);
        return text;
      },
    },
    { getAvailableProviderCount: () => 1 },
  );
  const lines = footer.render(80);
  assert.equal(lines.length, 3);
  assert.match(lines[2] ?? "", /^tmp\/project · Subagents/);
  assert.match(lines[2] ?? "", /↑11 ↓22 R33 W44 \$0\.300$/);
  assert.deepEqual(colors, ["text", "text", "text", "text", "text", "text"]);

  factory = undefined;
  handlers.get("session_start")?.({}, { ...ctx, mode: "print" });
  assert.equal(factory, undefined);
});
