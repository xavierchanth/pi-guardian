import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeProcessHarness, initializeParams } from "./process-harness.ts";

test("spawned worker keeps stdout protocol-only and shuts down cleanly", async () => {
  const worker = new RuntimeProcessHarness({
    env: {
      PI_TAI_RUNTIME_TEST_CONSOLE: "1",
      PI_TAI_RUNTIME_FAKE_PORT: "1",
    },
  });
  const initialized = await worker.command("init", "runtime.initialize", initializeParams(1));
  assert.equal(initialized.ok, true);
  assert.ok(await worker.waitFor((frame) => frame.event === "runtime.ready"));
  assert.equal((await worker.command("shutdown", "runtime.shutdown", {})).ok, true);
  assert.deepEqual(await worker.waitForExit(), { code: 0, signal: null });
  assert.doesNotMatch(JSON.stringify(worker.frames), /contamination probe/);
  assert.match(worker.stderr, /"event":"console"/);
});
