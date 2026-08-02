import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "../..");

test("shared dashboard projections have no terminal or TUI dependency", () => {
  for (const file of [
    "packages/pi-tai/src/core/dashboard/viewport.ts",
    "packages/pi-tai/src/core/subagents/dashboard.ts",
  ]) {
    const source = readFileSync(join(root, file), "utf8");
    assert.doesNotMatch(source, /@earendil-works\/pi-tui|\/terminal\//);
  }
});

test("core dashboard view receives terminal rows through the composition facade", () => {
  const view = readFileSync(
    join(root, "packages/pi-tai/src/core/subagents/dashboard-view.ts"),
    "utf8",
  );
  assert.doesNotMatch(view, /(?:from|import\()\s*["'][^"']*terminal(?:\/|["'])/);
  assert.match(view, /readRows: \(tui: TUI\) => number/);

  const facade = readFileSync(join(root, "packages/pi-tai/pi-tai.ts"), "utf8");
  assert.match(facade, /readDashboardRows: terminalRows/);
});

test("terminal budget is read only by the terminal adapter with a documented fallback", () => {
  const source = readFileSync(join(root, "packages/pi-tai/src/terminal/dashboard/rows.ts"), "utf8");
  assert.match(source, /\.terminal\?\.rows/);
  assert.match(source, /FALLBACK_TERMINAL_ROWS/);
});
