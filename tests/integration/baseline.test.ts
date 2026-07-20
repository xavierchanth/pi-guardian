import assert from "node:assert/strict";
import test from "node:test";

test("integration harness is available", () => {
  assert.ok(import.meta.dirname.endsWith("integration"));
});
