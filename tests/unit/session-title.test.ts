import assert from "node:assert/strict";
import test from "node:test";
import {
  heuristicSessionTitle,
  isMeaningfulPrompt,
  normalizeSessionTitle,
} from "../../packages/pi-tai/src/session-title/normalize.ts";

test("normalizes quotes, Markdown, punctuation, whitespace, and word limits", () => {
  assert.equal(
    normalizeSessionTitle("  **“Implement   the terminal plugin system!”**  ", 4),
    "Implement the terminal plugin",
  );
  assert.equal(normalizeSessionTitle("first\nsecond\nthird", 2), "first second");
});

test("builds a deterministic heuristic without command prefixes", () => {
  assert.equal(
    heuristicSessionTitle("/plan reorganize the repository safely. Then test it.", 5),
    "Reorganize the repository safely",
  );
  assert.equal(heuristicSessionTitle("...", 6), "New session");
});

test("ignores empty and command-only prompts", () => {
  assert.equal(isMeaningfulPrompt("  "), false);
  assert.equal(isMeaningfulPrompt("/reload"), false);
  assert.equal(isMeaningfulPrompt("Implement this"), true);
});
