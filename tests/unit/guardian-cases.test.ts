import assert from "node:assert/strict";
import test from "node:test";
import { validateGuardianFallbackCorpus } from "../../evals/guardian/cases.ts";

function corpusWithTitle(title: string): unknown {
  return {
    version: 1,
    suite: "guardian-review-fallback",
    description: "URL validation fixture",
    cases: [
      {
        id: "url-validation",
        title,
        reviewFailure: "timeout",
        action: { toolName: "bash", cwd: ".", arguments: { command: "pwd" } },
        expected: {
          classification: "local-read-only",
          disposition: "allow",
          rationale: "Synthetic fixture",
        },
      },
    ],
  };
}

test("guardian corpus accepts only the reserved synthetic URL host", () => {
  assert.doesNotThrow(() =>
    validateGuardianFallbackCorpus(corpusWithTitle("See https://example.invalid/path")),
  );
  assert.throws(
    () => validateGuardianFallbackCorpus(corpusWithTitle("See https://example.com/path")),
    /only reserved synthetic URL hosts are permitted/,
  );
});
