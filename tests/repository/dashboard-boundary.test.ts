import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "../..");

test("shared dashboard projections have no terminal or TUI dependency", () => {
  for (const file of [
    "packages/pi-tai/src/core/dashboard/viewport.ts",
    "packages/pi-tai/src/core/dashboard/row-source.ts",
    "packages/pi-tai/src/core/subagents/dashboard.ts",
  ]) {
    const source = readFileSync(join(root, file), "utf8");
    assert.doesNotMatch(source, /@earendil-works\/pi-tui|\/terminal\//);
  }
});

test("core composes outward to terminal without reversing the dependency", () => {
  const coreRegister = readFileSync(
    join(root, "packages/pi-tai/src/core/subagents/register.ts"),
    "utf8",
  );
  assert.doesNotMatch(coreRegister, /(?:from|import\()\s*["'][^"']*terminal/);
  assert.match(coreRegister, /dependencies\.registerDashboard\?\.\(pi, \(\) => built\?\.agents\)/);
  assert.match(coreRegister, /SQLiteCustodyCoordinator/);
  assert.match(coreRegister, /coordinator\.recover\(\)/);
});

test("thin terminal shell receives rows through the composition facade", () => {
  const view = readFileSync(join(root, "packages/pi-tai/src/terminal/dashboard/view.ts"), "utf8");
  assert.match(view, /readRows: \(tui: TUI\) => number/);
  assert.doesNotMatch(view, /JjCli|SQLiteWorkspaceManager/);

  const facade = readFileSync(join(root, "packages/pi-tai/pi-tai.ts"), "utf8");
  assert.match(facade, /registerDashboardShell\(api, resolveAgents, terminalRows\)/);
  assert.match(facade, /registerAgents/);
});

test("superseded dashboard and retired command/bindings are absent", () => {
  assert.equal(
    existsSync(join(root, "packages/pi-tai/src/core/subagents/dashboard-view.ts")),
    false,
  );
  const source = readFileSync(join(root, "packages/pi-tai/src/terminal/dashboard/view.ts"), "utf8");
  assert.doesNotMatch(source, /register\(["']dashboard["']/);
  assert.doesNotMatch(source, /matchesKey\(data, ["'][\[\]]["']\)/);
});

test("terminal budget is read only by the terminal adapter with a documented fallback", () => {
  const source = readFileSync(join(root, "packages/pi-tai/src/terminal/dashboard/rows.ts"), "utf8");
  assert.match(source, /\.terminal\?\.rows/);
  assert.match(source, /FALLBACK_TERMINAL_ROWS/);
});
