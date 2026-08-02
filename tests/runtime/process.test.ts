import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { initializeParams, RuntimeProcessHarness } from "./process-harness.ts";

test("process harness rejects every caller-supplied XDG override", () => {
  for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"]) {
    assert.throws(
      () => new RuntimeProcessHarness({ env: { [key]: "/caller-owned" } }),
      new RegExp(`${key} is harness-owned`),
    );
  }
});

test("process harness removes private XDG roots when spawn fails", async () => {
  const worker = new RuntimeProcessHarness({ executable: "/definitely/not/a/runtime-executable" });
  assert.equal(existsSync(worker.xdgRoot), true);
  await new Promise<void>((resolve) => {
    worker.child.once("error", () => undefined);
    worker.child.once("close", () => resolve());
  });
  assert.equal(existsSync(worker.xdgRoot), false);
});

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
