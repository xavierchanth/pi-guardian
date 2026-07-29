import assert from "node:assert/strict";
import test from "node:test";
import {
  DASHBOARD_EMPTY,
  DASHBOARD_HINT,
  DASHBOARD_TITLE,
  clampSelection,
  dashboardText,
  formatElapsed,
  renderDashboard,
  type DashboardRow,
} from "../../packages/pi-tai/src/agents/dashboard.ts";
import { emptySnapshot, type SubagentSnapshot } from "../../packages/pi-tai/src/agents/domain.ts";

const NOW = Date.parse("2026-01-01T00:05:00.000Z");
const WIDTH = 96;

function snapshot(overrides: Partial<SubagentSnapshot> & { id: string }): SubagentSnapshot {
  return {
    ...emptySnapshot({
      id: overrides.id,
      backend: "pi",
      title: `Task ${overrides.id}`,
      cwd: "/repo",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    ...overrides,
  };
}

const running = snapshot({
  id: "sa-1",
  model: "gpt-5.6-sol",
  usage: { inputTokens: 60_000, outputTokens: 8_000, contextWindow: 200_000 },
});

const settled = snapshot({
  id: "sa-2",
  title: "Write the migration",
  status: "done",
  settledAt: "2026-01-01T00:01:30.000Z",
  model: "claude-opus-5",
  usage: { inputTokens: 1_000, outputTokens: 500 },
});

function bodyLines(rows: readonly DashboardRow[]): string[] {
  // Drop the borders and the trailing blank, notice, and hint rows.
  return dashboardText(rows).slice(1, -3);
}

test("shows an empty state when nothing has been delegated", () => {
  const lines = dashboardText(renderDashboard({ snapshots: [], selected: 0, width: WIDTH, now: NOW }));

  assert.ok(lines[0]?.includes(DASHBOARD_TITLE));
  assert.equal(lines.length, 5);
  assert.ok(lines[1]?.includes(DASHBOARD_EMPTY));
  assert.ok(lines.at(-2)?.includes(DASHBOARD_HINT));
  assert.ok(lines.at(-1)?.startsWith("└"));
});

test("lists a running and a settled subagent with status, model, and elapsed time", () => {
  const rows = renderDashboard({ snapshots: [running, settled], selected: 0, width: WIDTH, now: NOW });
  const [first, second] = bodyLines(rows);

  assert.ok(first?.includes("● Task sa-1 sa-1"));
  assert.ok(first?.includes("gpt-5.6-sol"));
  assert.ok(first?.includes("5m00s"), first);
  assert.ok(first?.endsWith("running │"), first);

  // A settled subagent stops accruing time at its settlement, not at `now`.
  assert.ok(second?.includes("✓ Write the migration sa-2"));
  assert.ok(second?.includes("1m30s"), second);
  assert.ok(second?.includes("done"));
});

test("marks only the selected row and clamps out-of-range selections", () => {
  const [first, second] = bodyLines(
    renderDashboard({ snapshots: [running, settled], selected: 1, width: WIDTH, now: NOW }),
  );
  assert.ok(first?.startsWith("│   ●"), first);
  assert.ok(second?.startsWith("│ › ✓"), second);

  const [clampedFirst, clampedSecond] = bodyLines(
    renderDashboard({ snapshots: [running, settled], selected: 9, width: WIDTH, now: NOW }),
  );
  assert.ok(clampedFirst?.startsWith("│   ●"), clampedFirst);
  assert.ok(clampedSecond?.startsWith("│ › ✓"), clampedSecond);

  assert.equal(clampSelection(2, -3), 0);
  assert.equal(clampSelection(0, 4), 0);
});

test("shows context utilisation only when the context window is known", () => {
  const [known] = bodyLines(renderDashboard({ snapshots: [running], selected: 0, width: WIDTH, now: NOW }));
  assert.ok(known?.includes("ctx 34%"), known);

  const [unknown] = bodyLines(renderDashboard({ snapshots: [settled], selected: 0, width: WIDTH, now: NOW }));
  assert.ok(unknown?.includes("ctx --"), unknown);
});

test("renders a notice above the key hint and tones failures as errors", () => {
  const rows = renderDashboard({
    snapshots: [running],
    selected: 0,
    width: WIDTH,
    now: NOW,
    notice: "Unknown subagent sa-9.",
  });
  const notice = rows.at(-3);

  assert.equal(notice?.tone, "error");
  assert.ok(notice?.text.includes("Unknown subagent sa-9."));
});

test("formats elapsed time across second, minute, and hour scales", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(42_000), "42s");
  assert.equal(formatElapsed(90_000), "1m30s");
  assert.equal(formatElapsed(3 * 3_600_000 + 4 * 60_000), "3h04m");
});
