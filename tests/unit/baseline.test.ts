import assert from "node:assert/strict";
import test from "node:test";

test("Node can execute TypeScript tests", () => {
  const value: string = "pi-tai";
  assert.equal(value, "pi-tai");
});
