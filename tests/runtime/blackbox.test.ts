import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RuntimeProcessHarness, initializeParams, pinnedPolicyParams } from "./process-harness.ts";

async function isolatedRoot() {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-blackbox-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
  return { root, cwd, agentDir, sessionDir };
}

test("spawned Pi SDK worker persists, reopens, streams, cancels, and exits without network models", async () => {
  const paths = await isolatedRoot();
  const env = {
    HOME: paths.root,
    PI_CODING_AGENT_DIR: paths.agentDir,
    PI_OFFLINE: "1",
  };
  const first = new RuntimeProcessHarness({ env });
  const initialized = await first.command("init-1", "runtime.initialize", initializeParams(1));
  assert.equal(initialized.ok, true);
  assert.equal(initialized.result.capabilities.tools.includes("update_plan"), false);
  const created = await first.command("create", "session.create", {
    cwd: paths.cwd,
    agentDir: paths.agentDir,
    sessionDir: paths.sessionDir,
    ...pinnedPolicyParams,
    faux: true,
  });
  assert.equal(created.ok, true);
  const sessionFile = created.result.sessionFile as string;
  assert.ok(
    (
      await first.waitFor((frame) => frame.event === "session.ready")
    ).data.capabilities.commands.includes("continue"),
  );
  assert.equal(
    (
      await first.command("prompt-a", "session.prompt", {
        turnId: "turn-a",
        text: "first persisted turn",
      })
    ).ok,
    true,
  );
  await first.waitFor((frame) => frame.event === "session.idle" && frame.turnId === "turn-a");
  assert.equal((await first.command("shutdown-1", "runtime.shutdown", {})).ok, true);
  assert.deepEqual(await first.waitForExit(), { code: 0, signal: null });

  const second = new RuntimeProcessHarness({ env });
  assert.equal(
    (await second.command("init-2", "runtime.initialize", initializeParams(2))).ok,
    true,
  );
  assert.equal(
    (
      await second.command("open", "session.open", {
        sessionFile,
        agentDir: paths.agentDir,
        sessionDir: paths.sessionDir,
        ...pinnedPolicyParams,
        faux: true,
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await second.command("prompt-b", "session.prompt", {
        turnId: "turn-b",
        text: "verify history",
      })
    ).ok,
    true,
  );
  await second.waitFor((frame) => frame.event === "session.idle" && frame.turnId === "turn-b");
  const continuedText = second.frames
    .filter((frame) => frame.event === "assistant.text_delta" && frame.turnId === "turn-b")
    .map((frame) => frame.data.delta)
    .join("");
  assert.match(continuedText, /history-present/);

  assert.equal(
    (
      await second.command("slow", "session.prompt", {
        turnId: "turn-slow",
        text: "slow response",
      })
    ).ok,
    true,
  );
  assert.equal(
    (await second.command("cancel", "session.cancel", { turnId: "turn-slow" })).result.accepted,
    true,
  );
  await second.waitFor(
    (frame) => frame.event === "session.interrupted" && frame.turnId === "turn-slow",
  );
  await second.waitFor((frame) => frame.event === "session.idle" && frame.turnId === "turn-slow");
  assert.equal((await second.command("shutdown-2", "runtime.shutdown", {})).ok, true);
  assert.deepEqual(await second.waitForExit(), { code: 0, signal: null });

  assert.match(await readFile(sessionFile, "utf8"), /first persisted turn/);
  assert.doesNotMatch(
    first.stderr + second.stderr,
    /first persisted turn|verify history|slow response/,
  );
  for (const frame of [...first.frames, ...second.frames]) {
    assert.equal(frame.protocolVersion, 2);
  }
});

test("SIGTERM interrupts an active Pi turn and leaves parseable session history", async () => {
  const paths = await isolatedRoot();
  const worker = new RuntimeProcessHarness({
    env: {
      HOME: paths.root,
      PI_CODING_AGENT_DIR: paths.agentDir,
      PI_OFFLINE: "1",
    },
  });
  await worker.command("init", "runtime.initialize", initializeParams(1));
  const created = await worker.command("create", "session.create", {
    cwd: paths.cwd,
    agentDir: paths.agentDir,
    sessionDir: paths.sessionDir,
    ...pinnedPolicyParams,
    faux: true,
  });
  await worker.command("slow", "session.prompt", { turnId: "turn-signal", text: "slow response" });
  worker.child.kill("SIGTERM");
  assert.deepEqual(await worker.waitForExit(), { code: 0, signal: null });
  assert.ok(
    worker.frames.some(
      (frame) => frame.event === "session.interrupted" && frame.turnId === "turn-signal",
    ),
  );
  const history = await readFile(created.result.sessionFile, "utf8");
  for (const line of history.trim().split("\n")) JSON.parse(line);
});
