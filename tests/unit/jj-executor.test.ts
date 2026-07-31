import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  absolutePath,
  changeDescription,
  changeId,
  isolatedWorkspaceWriteLease,
  workspaceId,
  workspaceRebaseLease,
  workspaceWriteLeaseId,
} from "../../packages/pi-tai/src/core/jj/domain.ts";
import { JjProcessExecutor, SUPPORTED_JJ_VERSION } from "../../packages/pi-tai/src/core/jj/executor.ts";

async function fakeJj(body: string): Promise<{ root: string; binary: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-fake-jj-"));
  const binary = join(root, "jj");
  await writeFile(binary, `#!/usr/bin/env node\n${body}\n`, { mode: 0o700 });
  await chmod(binary, 0o700);
  return { root, binary };
}

test("JJ semantic values reject ambiguous identities and unbounded descriptions", () => {
  assert.equal(changeId("a".repeat(32)), "a".repeat(32));
  assert.throws(() => changeId("short"), /full JJ Change ID/);
  assert.equal(changeDescription("  feat: checkpoint work  "), "feat: checkpoint work");
  assert.throws(() => changeDescription(" "), /must not be empty/);
  assert.throws(() => changeDescription("x".repeat(4097)), /exceeds 4096 bytes/);

  const lease = isolatedWorkspaceWriteLease(
    workspaceId("workspace-1"),
    workspaceWriteLeaseId("lease-1"),
  );
  assert.deepEqual(lease, {
    kind: "isolated_workspace_write_lease",
    workspaceId: "workspace-1",
    leaseId: "lease-1",
  });
  assert.equal("path" in lease, false);
  assert.equal("headChangeId" in lease, false);
  const rebaseLease = workspaceRebaseLease(
    workspaceId("workspace-1"),
    workspaceWriteLeaseId("rebase-1"),
  );
  assert.deepEqual(rebaseLease, {
    kind: "workspace_rebase_lease",
    workspaceId: "workspace-1",
    leaseId: "rebase-1",
  });
});

test("JJ process executor probes 0.43.0 and invokes argv with deterministic global options", async () => {
  const fixture = await fakeJj(`
if (process.argv[2] === "--version") {
  process.stdout.write("jj ${SUPPORTED_JJ_VERSION}\\n");
} else {
  process.stdout.write(JSON.stringify({ args: process.argv.slice(2), inherited: process.env.PI_TAI_EXECUTOR_TEST }));
}
`);
  const executor = new JjProcessExecutor({
    binary: fixture.binary,
    environment: { ...process.env, PI_TAI_EXECUTOR_TEST: "inherited-config" },
  });
  assert.deepEqual(await executor.probe(), {
    kind: "available",
    binary: fixture.binary,
    version: SUPPORTED_JJ_VERSION,
  });
  const result = await executor.execute({
    cwd: absolutePath(fixture.root),
    access: "read",
    args: ["log", "--revision", "@", "--no-graph", "--template", "change_id"],
  });
  assert.equal(result.kind, "success");
  if (result.kind !== "success") return;
  assert.deepEqual(JSON.parse(result.stdout), {
    args: [
      "--no-pager",
      "--color=never",
      "log",
      "--revision",
      "@",
      "--no-graph",
      "--template",
      "change_id",
    ],
    inherited: "inherited-config",
  });
});

test("JJ process executor rejects unsupported versions before commands", async () => {
  const fixture = await fakeJj(`
if (process.argv[2] === "--version") process.stdout.write("jj 0.42.0\\n");
else process.stdout.write("should-not-run");
`);
  const executor = new JjProcessExecutor({ binary: fixture.binary });
  const result = await executor.execute({
    cwd: absolutePath(fixture.root),
    access: "read",
    args: ["root"],
  });
  assert.equal(result.kind, "failure");
  if (result.kind !== "failure") return;
  assert.deepEqual(result.failure, {
    kind: "unsupported_version",
    expected: "0.43.0",
    observed: "0.42.0",
  });
  assert.equal(result.stdout, "");
});

test("JJ process executor classifies timeout, cancellation, output limits, and missing binary", async () => {
  const fixture = await fakeJj(`
if (process.argv[2] === "--version") process.stdout.write("jj ${SUPPORTED_JJ_VERSION}\\n");
else if (process.argv.includes("emit")) process.stdout.write("x".repeat(100));
else setTimeout(() => process.stdout.write("late"), 10_000);
`);
  const outputExecutor = new JjProcessExecutor({ binary: fixture.binary });
  const output = await outputExecutor.execute({
    cwd: absolutePath(fixture.root),
    access: "read",
    args: ["emit"],
    outputLimitBytes: 10,
  });
  assert.equal(output.kind, "failure");
  if (output.kind === "failure")
    assert.deepEqual(output.failure, {
      kind: "output_limit_exceeded",
      stream: "stdout",
      limitBytes: 10,
    });

  const timeoutExecutor = new JjProcessExecutor({ binary: fixture.binary });
  const timed = await timeoutExecutor.execute({
    cwd: absolutePath(fixture.root),
    access: "read",
    args: ["wait"],
    timeoutMs: 20,
  });
  assert.equal(timed.kind, "failure");
  if (timed.kind === "failure")
    assert.deepEqual(timed.failure, { kind: "timed_out", timeoutMs: 20 });

  const controller = new AbortController();
  const cancelExecutor = new JjProcessExecutor({ binary: fixture.binary });
  const pending = cancelExecutor.execute({
    cwd: absolutePath(fixture.root),
    access: "read",
    args: ["wait"],
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  const cancelled = await pending;
  assert.equal(cancelled.kind, "failure");
  if (cancelled.kind === "failure") assert.deepEqual(cancelled.failure, { kind: "cancelled" });

  const missing = new JjProcessExecutor({ binary: join(fixture.root, "missing-jj") });
  const unavailable = await missing.execute({
    cwd: absolutePath(fixture.root),
    access: "read",
    args: ["root"],
  });
  assert.equal(unavailable.kind, "failure");
  if (unavailable.kind === "failure")
    assert.deepEqual(unavailable.failure, {
      kind: "not_found",
      binary: join(fixture.root, "missing-jj"),
    });
});
