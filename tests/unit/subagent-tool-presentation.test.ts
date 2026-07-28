import assert from "node:assert/strict";
import test from "node:test";
import { ROLE_TOOL_NAMES } from "../../packages/pi-tai/src/subagents/domain.ts";
import { formatSubagentToolCall } from "../../packages/pi-tai/src/subagents/tool-presentation.ts";

test("every production subagent tool has a bounded semantic call presentation", () => {
  assert.equal(new Set(ROLE_TOOL_NAMES).size, 44);
  for (const name of ROLE_TOOL_NAMES) {
    const rendered = formatSubagentToolCall(name, name, {}, false);
    assert.ok(rendered.startsWith(name), name);
    assert.ok(rendered.length < 200, name);
  }
});

test("work-order creation calls surface execution class and objective", () => {
  const args = {
    executionClass: "small-product",
    objective: "Fix workspace recovery defect F1",
    instructions: "Fix and validate F1.",
    rationale: "The change is bounded.",
    acceptanceCriteria: ["Fail closed"],
    constraints: ["Keep the patch focused"],
  };
  assert.equal(formatSubagentToolCall("work_order_create", "Create Work Order", args, false), "Create Work Order small-product · Fix workspace recovery defect F1");
  const expanded = formatSubagentToolCall("work_order_create", "Create Work Order", args, true);
  assert.match(expanded, /Acceptance Criteria:\n  • Fail closed/);
  assert.match(expanded, /Constraints:\n  • Keep the patch focused/);
});

test("work-order revisions surface replacement instructions and rationale", () => {
  const args = {
    instructions: "## Workstream A\n\n1. Fix F1.",
    rationale: "Recovery must fail closed.",
    directionIds: ["direction-secret-provenance"],
  };
  assert.equal(formatSubagentToolCall("work_order_revise", "Revise Work Order", args, false), "Revise Work Order Workstream A · Recovery must fail closed.");
  const expanded = formatSubagentToolCall("work_order_revise", "Revise Work Order", args, true);
  assert.match(expanded, /Instructions:\n  ## Workstream A\n  1\. Fix F1\./);
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
  const rendered = formatSubagentToolCall("work_order_create", "Create Work Order", {
    executionClass: "small-product", objective: "x".repeat(2_000),
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
