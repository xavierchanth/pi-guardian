import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  loadConcurrencyCases,
  validateConcurrencyCase,
} from "../../evals/agent-concurrency/cases.ts";

test("agent concurrency benchmark fixtures include policy and Real-JJ cases", async () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const cases = await loadConcurrencyCases(join(root, "../../evals/agent-concurrency/cases"));
  assert.deepEqual(cases.map((item) => item.mode).sort(), ["policy", "real-jj"]);
  assert.ok(
    cases.every((item) => item.expectedTools.every((tool) => !item.forbiddenTools.includes(tool))),
  );
});

test("agent concurrency benchmark schema rejects unknown and contradictory fields", () => {
  const base = {
    version: 1,
    suite: "agent-concurrency",
    id: "valid-case",
    title: "Valid case",
    mode: "policy",
    prompt: "Choose a bounded tool.",
    expectedTools: ["checkpoint_change"],
    forbiddenTools: ["workspace_checkpoint"],
    expectedReportFields: ["receipt"],
  };
  assert.equal(validateConcurrencyCase(base).id, "valid-case");
  assert.throws(() => validateConcurrencyCase({ ...base, surprise: true }), /unknown field/);
  assert.throws(
    () => validateConcurrencyCase({ ...base, forbiddenTools: ["checkpoint_change"] }),
    /also forbidden/,
  );
});
