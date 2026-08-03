import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  type FooterSnapshot,
  footerRowText,
  formatWorkspacePath,
  renderFooterRows,
} from "../../packages/pi-tai/src/terminal/footer/render.ts";

const snapshot: FooterSnapshot = {
  cwd: "/home/example/projects/pi-tai",
  usage: { input: 465_000, output: 35_000, cacheRead: 7_200_000, cacheWrite: 0, cost: 6.991 },
  contextWindow: 272_000,
  contextPercent: 67.6,
  usingSubscription: true,
  model: "gpt-5.6-sol",
  reasoning: true,
  thinkingLevel: "low",
  subagents: {
    latest: {
      displayId: "sa-2",
      activity: "bash: npm test",
      lastActivityAt: "2026-01-02T00:00:00Z",
    },
    totals: { running: 1, done: 2, error: 0 },
  },
};

test("renders the exact three-row subagent footer contract", () => {
  const rows = renderFooterRows(snapshot, 100);
  const lines = rows.map(footerRowText);
  assert.equal(lines.length, 3);
  assert.ok(lines[0]?.startsWith("sa-2 · bash: npm test"));
  assert.ok(lines[0]?.endsWith("gpt-5.6-sol · low"));
  assert.ok(lines[1]?.startsWith("Subagents: 1 running · 2 done · 0 error"));
  assert.ok(lines[1]?.endsWith("67.6%/272k"));
  assert.ok(lines[2]?.startsWith("projects/pi-tai"));
  assert.ok(lines[2]?.endsWith("↑465k ↓35k R7.2M $6.991 (sub)"));
  for (const line of lines) assert.equal(visibleWidth(line), 100);
});

test("preserves RHS and labels non-subscription reported cost", () => {
  const lines = renderFooterRows({ ...snapshot, usingSubscription: false }, 100).map(footerRowText);
  assert.ok(lines[2]?.endsWith("↑465k ↓35k R7.2M $6.991 (api)"));
  assert.equal(lines[1]?.includes("(auto)"), false);
});

test("narrow widths preserve RHS and never overflow", () => {
  const rows = renderFooterRows(
    {
      ...snapshot,
      subagents: {
        ...snapshot.subagents,
        latest: {
          displayId: "sa-2",
          activity: "A very long projected activity that cannot fit",
          lastActivityAt: "2026-01-02",
        },
      },
    },
    48,
  );
  const lines = rows.map(footerRowText);
  assert.ok(lines[0]?.endsWith("gpt-5.6-sol · low"));
  assert.ok(lines[1]?.endsWith("67.6%/272k"));
  assert.ok(lines[0]?.includes("..."));
  for (const line of lines) assert.equal(visibleWidth(line), 48);
});

test("sanitizes hostile activity controls at the final presentation boundary", () => {
  const rows = renderFooterRows(
    {
      ...snapshot,
      subagents: {
        ...snapshot.subagents,
        latest: {
          displayId: "sa-2\u001b[31m",
          activity: "hostile\u009b31m title\u0007\nnext",
          lastActivityAt: "2026-01-02",
        },
      },
    },
    100,
  );
  assert.ok(footerRowText(rows[0]!).startsWith("sa-2[31m · hostile31m titlenext"));
  assert.doesNotMatch(footerRowText(rows[0]!), /[\u0000-\u001f\u007f-\u009f]/u);
});

test("shows exactly the parent and current workspace path segments", () => {
  assert.equal(formatWorkspacePath("/home/example/projects/pi-tai"), "projects/pi-tai");
  assert.equal(formatWorkspacePath("/tmp/project"), "tmp/project");
});
