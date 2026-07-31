import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  footerRowText,
  formatWorkspacePath,
  renderFooterRows,
  type FooterSnapshot,
} from "../../packages/pi-tai/src/terminal/footer/render.ts";

const snapshot: FooterSnapshot = {
  cwd: "/home/example/projects/pi-tai",
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
  assert.ok(lines[2]?.startsWith("projects/pi-tai"));
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
