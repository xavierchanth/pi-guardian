import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "../..");

test("shared dashboard core has no terminal or TUI dependency", () => {
  for (const file of [
    "packages/pi-tai/src/core/dashboard/viewport.ts",
    "packages/pi-tai/src/core/subagents/dashboard.ts",
  ]) {
    const source = readFileSync(join(root, file), "utf8");
    assert.doesNotMatch(source, /@earendil-works\/pi-tui|\/terminal\//);
  }
});

test("terminal budget is read only by the terminal adapter with a documented fallback", () => {
  const source = readFileSync(join(root, "packages/pi-tai/src/terminal/dashboard/rows.ts"), "utf8");
  assert.match(source, /\.terminal\?\.rows/);
  assert.match(source, /FALLBACK_TERMINAL_ROWS/);
});
