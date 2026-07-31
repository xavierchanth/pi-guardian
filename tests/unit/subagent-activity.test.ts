import assert from "node:assert/strict";
import test from "node:test";
import {
  projectActivity,
  summarizeSubagentActivity,
} from "../../packages/pi-tai/src/core/subagents/activity.ts";
import { applyEvent, emptySnapshot } from "../../packages/pi-tai/src/core/subagents/domain.ts";
import { loadPackagedInstructions } from "../../packages/pi-tai/src/core/subagents/instructions.ts";

test("loads non-empty instructions from the packaged package-root path", () => {
  assert.ok(loadPackagedInstructions().system.trim().length > 0);
});

function child(id: string, createdAt: string) {
  return emptySnapshot({ id, backend: "pi", title: `objective ${id}`, cwd: "/tmp", createdAt });
}

test("latest selects the newest actual event across subagents, not creation order", () => {
  const newerCreated = applyEvent(
    child("sa-2", "2026-01-02T00:00:00Z"),
    { type: "run_started" },
    "2026-01-02T00:00:01Z",
  );
  const olderCreated = applyEvent(
    child("sa-1", "2026-01-01T00:00:00Z"),
    { type: "assistant_message", text: "new activity" },
    "2026-01-03T00:00:00Z",
  );
  const summary = summarizeSubagentActivity([olderCreated, newerCreated]);
  assert.equal(summary.latest?.displayId, "sa-1");
  assert.equal(summary.latest?.activity, "new activity");
  assert.deepEqual(summary.totals, { running: 2, done: 0, error: 0 });
});

test("safe projection prioritizes active tool preview and bounds terminal-safe text", () => {
  const started = applyEvent(
    child("sa-1", "2026-01-01T00:00:00Z"),
    {
      type: "assistant_message",
      text: "private transcript is not selected while a tool is active",
    },
    "2026-01-01T00:00:01Z",
  );
  const tooling = applyEvent(
    started,
    { type: "tool_start", toolId: "1", name: "bash", preview: `npm test\u001b${"x".repeat(200)}` },
    "2026-01-01T00:00:02Z",
  );
  const projected = projectActivity(tooling);
  assert.ok(projected.activity.startsWith("bash: npm test"));
  assert.equal(projected.activity.includes("private transcript"), false);
  assert.ok(projected.activity.length <= 120);
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/u.test(projected.activity), false);
});

test("sanitizes hostile fallback titles and truncates without splitting surrogates", () => {
  const snapshot = {
    ...child("sa-1", "2026-01-01T00:00:00Z"),
    title: `\u009bhostile\u0007${"😀".repeat(130)}`,
    latestText: " ",
  };
  const projected = projectActivity(snapshot);
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/u.test(projected.activity), false);
  assert.ok(projected.activity.endsWith("…"));
  assert.doesNotMatch(projected.activity, /[\ud800-\udbff]$/u);
});
