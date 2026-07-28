import assert from "node:assert/strict";
import test from "node:test";
import { ROLE_TOOL_NAMES } from "../../packages/pi-tai/src/subagents/domain.ts";
import { formatSubagentToolCall } from "../../packages/pi-tai/src/subagents/tool-presentation.ts";

test("every production subagent tool has a bounded semantic call presentation", () => {
  assert.equal(new Set(ROLE_TOOL_NAMES).size, 51);
  for (const name of ROLE_TOOL_NAMES) {
    const rendered = formatSubagentToolCall(name, name, {}, false);
    assert.ok(rendered.startsWith(name), name);
    assert.ok(rendered.length < 200, name);
  }
});

test("task assignment calls surface the issued role and objective", () => {
  const collapsed = formatSubagentToolCall("task_assign", "Assign Task", {
    ownerRole: "worker",
    objective: "Fix workspace recovery defect F1",
    acceptanceCriteria: ["Fail closed"],
    constraints: ["Keep the patch focused"],
  }, false);
  assert.equal(collapsed, "Assign Task worker · Fix workspace recovery defect F1");

  const expanded = formatSubagentToolCall("task_assign", "Assign Task", {
    ownerRole: "worker",
    objective: "Fix workspace recovery defect F1",
    acceptanceCriteria: ["Fail closed"],
    constraints: ["Keep the patch focused"],
  }, true);
  assert.match(expanded, /Acceptance Criteria:\n  • Fail closed/);
  assert.match(expanded, /Constraints:\n  • Keep the patch focused/);
});

test("task approval calls remain concise and explicit", () => {
  assert.equal(formatSubagentToolCall("task_approve_plan", "Approve Task Plan", {}, false), "Approve Task Plan");
});

test("task plan calls surface the replacement plan and rationale", () => {
  const collapsed = formatSubagentToolCall("task_plan", "Revise Task Plan", {
    markdown: "## Workstream A\n\n1. Fix F1.",
    rationale: "Recovery must fail closed.",
    directionIds: ["direction-secret-provenance"],
  }, false);
  assert.equal(collapsed, "Revise Task Plan Workstream A · Recovery must fail closed.");

  const expanded = formatSubagentToolCall("task_plan", "Revise Task Plan", {
    markdown: "## Workstream A\n\n1. Fix F1.",
    rationale: "Recovery must fail closed.",
    directionIds: ["direction-secret-provenance"],
  }, true);
  assert.match(expanded, /Plan:\n  ## Workstream A\n  1\. Fix F1\./);
  assert.match(expanded, /Rationale: Recovery must fail closed\./);
  assert.match(expanded, /Directions: 1/);
  assert.doesNotMatch(expanded, /direction-secret-provenance/);
});

test("delegation calls show the child task rather than raw packet JSON", () => {
  const rendered = formatSubagentToolCall("subagent", "Subagent", {
    agent: "reviewer",
    taskId: "task-12345678-1234-1234-1234-123456789abc",
    task: {
      objective: "Review the exact frozen range",
      resources: [{ type: "file", value: "review.json", reason: "Immutable evidence" }],
      constraints: ["Read-only"],
      expectedOutput: "Structured findings",
      uncertaintyHandling: "block",
    },
  }, true);
  assert.match(rendered, /^Subagent reviewer · Review the exact frozen range/m);
  assert.match(rendered, /Resources:\n  • file · review\.json · Immutable evidence/);
  assert.match(rendered, /Constraints:\n  • Read-only/);
  assert.match(rendered, /Expected output: Structured findings/);
});

test("collapsed calls bound long semantic text", () => {
  const rendered = formatSubagentToolCall("task_create", "Create Task", {
    objective: "x".repeat(2_000),
  }, false);
  assert.ok(rendered.length < 300);
  assert.match(rendered, /…$/);
});

test("operational calls summarize bounded counts and targets", () => {
  assert.equal(
    formatSubagentToolCall("acquire_file_set", "Acquire File Set", { paths: ["a.ts", "b.ts"] }, false),
    "Acquire File Set 2 paths",
  );
  assert.equal(
    formatSubagentToolCall("verify_integrated_range", "Verify Integrated Range", {
      delegationId: "12345678-1234-1234-1234-123456789abc",
      productChecks: ["typecheck", "unit tests"],
    }, false),
    "Verify Integrated Range 12345678… · 2 checks",
  );
});
