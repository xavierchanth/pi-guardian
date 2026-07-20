import assert from "node:assert/strict";
import test from "node:test";
import {
  formatWorkContext,
  parseWorkContextDetails,
  validateWorkContextUpdate,
  workContextDetails,
} from "../../packages/pi-tai/src/work-context/domain.ts";
import { latestWorkContext } from "../../packages/pi-tai/src/work-context/persistence.ts";
import {
  collapsedWorkContextText,
  fullWorkContextText,
  workContextStatusLines,
} from "../../packages/pi-tai/src/work-context/presentation.ts";

test("accepts an empty plan for simple work", () => {
  const snapshot = validateWorkContextUpdate({ goal: "Answer the question", plan: [] });
  assert.deepEqual(snapshot, { goal: "Answer the question", plan: [] });
});

test("normalizes a complete replacement snapshot", () => {
  const snapshot = validateWorkContextUpdate({
    goal: "  Ship   terminal refresh ",
    explanation: "  Plan changed  after review ",
    plan: [
      { content: " Build baseline ", status: "completed" },
      { content: " Add work context ", status: "in_progress", priority: "high" },
    ],
  }, {
    goal: "Ship terminal refresh",
    plan: [
      { content: "Build baseline", status: "in_progress" },
      { content: "Add work context", status: "pending" },
    ],
  });

  assert.equal(snapshot.goal, "Ship terminal refresh");
  assert.equal(snapshot.explanation, "Plan changed after review");
  assert.equal(snapshot.plan[0]?.status, "completed");
  assert.equal(snapshot.plan[1]?.priority, "high");
});

test("allows at most one in-progress item", () => {
  assert.throws(() => validateWorkContextUpdate({
    goal: "test",
    plan: [
      { content: "one", status: "in_progress" },
      { content: "two", status: "in_progress" },
    ],
  }), /at most one/);
});

test("requires an accepted in-progress snapshot before completion", () => {
  const previous = validateWorkContextUpdate({
    goal: "test",
    plan: [{ content: "one", status: "pending" }],
  });
  assert.throws(() => validateWorkContextUpdate({
    goal: "test",
    plan: [{ content: "one", status: "completed" }],
  }, previous), /must be in_progress/);

  const active = validateWorkContextUpdate({
    goal: "test",
    plan: [{ content: "one", status: "in_progress" }],
  }, previous);
  const complete = validateWorkContextUpdate({
    goal: "test",
    plan: [{ content: "one", status: "completed" }],
  }, active);
  assert.equal(complete.plan[0]?.status, "completed");
});

test("renamed and duplicate items are treated as new identities", () => {
  const previous = validateWorkContextUpdate({
    goal: "test",
    plan: [{ content: "old name", status: "in_progress" }],
  });
  assert.throws(() => validateWorkContextUpdate({
    goal: "test",
    plan: [{ content: "new name", status: "completed" }],
  }, previous), /must be in_progress/);
  assert.throws(() => validateWorkContextUpdate({
    goal: "test",
    plan: [
      { content: "Same item", status: "pending" },
      { content: " same   item ", status: "pending" },
    ],
  }), /Duplicate/);
});

test("details and readable text contain the full snapshot", () => {
  const snapshot = validateWorkContextUpdate({
    goal: "Ship",
    explanation: "Keep context",
    plan: [{ content: "Implement", status: "in_progress", priority: "medium" }],
  });
  const details = workContextDetails(snapshot);
  assert.deepEqual(parseWorkContextDetails(details), snapshot);
  assert.match(formatWorkContext(snapshot), /Goal: Ship/);
  assert.match(formatWorkContext(snapshot), /Implement \(in_progress; priority: medium\)/);
});

test("builds the approved two-line status presentation", () => {
  const snapshot = validateWorkContextUpdate({
    goal: "Ship terminal refresh",
    plan: [
      { content: "Establish baseline", status: "completed" },
      { content: "Integrate Guardian", status: "in_progress", priority: "high" },
      { content: "Run acceptance", status: "pending" },
    ],
  }, {
    goal: "Ship terminal refresh",
    plan: [
      { content: "Establish baseline", status: "in_progress" },
      { content: "Integrate Guardian", status: "pending" },
      { content: "Run acceptance", status: "pending" },
    ],
  });

  assert.deepEqual(workContextStatusLines(snapshot), [
    "Goal: Ship terminal refresh",
    "Plan: 1/3 | Now: Integrate Guardian",
  ]);
  assert.equal(
    collapsedWorkContextText(snapshot),
    "✓ Plan 1/3 · Now: Integrate Guardian",
  );
  assert.match(fullWorkContextText(snapshot), /\[x] Establish baseline/);
  assert.match(fullWorkContextText(snapshot), /\[>] Integrate Guardian \[high]/);
});

test("presents empty and completed plans clearly", () => {
  const empty = validateWorkContextUpdate({ goal: "Answer", plan: [] });
  assert.deepEqual(workContextStatusLines(empty), [
    "Goal: Answer",
    "Plan: No active steps",
  ]);

  const active = validateWorkContextUpdate({
    goal: "Finish",
    plan: [{ content: "Only step", status: "in_progress" }],
  });
  const complete = validateWorkContextUpdate({
    goal: "Finish",
    plan: [{ content: "Only step", status: "completed" }],
  }, active);
  assert.equal(collapsedWorkContextText(complete), "✓ Plan 1/1 · Complete");
  assert.equal(workContextStatusLines(complete)[1], "Plan: 1/1 | Complete");
});

test("reconstructs the latest valid snapshot on the active branch", () => {
  const first = workContextDetails(validateWorkContextUpdate({
    goal: "First",
    plan: [{ content: "one", status: "in_progress" }],
  }));
  const second = workContextDetails(validateWorkContextUpdate({
    goal: "Second",
    plan: [],
  }));
  const branch = [
    { type: "message", message: { role: "toolResult", toolName: "update_plan", details: first } },
    { type: "compaction", summary: "older context" },
    { type: "message", message: { role: "toolResult", toolName: "other", details: second } },
    { type: "message", message: { role: "toolResult", toolName: "update_plan", details: second } },
  ];
  assert.equal(latestWorkContext(branch)?.goal, "Second");
});
