import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { resolveStoragePaths } from "../../packages/pi-tai/src/core/storage/paths.ts";
import { createPrivateXdgRoots } from "./private-xdg.ts";
import { initializeParams, RuntimeProcessHarness } from "./process-harness.ts";

test("private XDG roots preserve runtime-variable presence without inheriting its path", () => {
  const absent = createPrivateXdgRoots("pi-runtime-no-runtime-", {});
  const hostRuntime = join(absent.root, "host-runtime");
  const present = createPrivateXdgRoots("pi-runtime-with-runtime-", {
    XDG_RUNTIME_DIR: hostRuntime,
  });
  try {
    assert.equal(absent.env.XDG_RUNTIME_DIR, undefined);
    assert.equal(
      resolveStoragePaths(absent.env).runtime,
      join(absent.root, "cache", "pi-tai", "run"),
    );
    assert.notEqual(present.env.XDG_RUNTIME_DIR, hostRuntime);
    assert.ok(present.env.XDG_RUNTIME_DIR?.startsWith(present.root));
  } finally {
    absent.remove();
    present.remove();
  }
});

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
