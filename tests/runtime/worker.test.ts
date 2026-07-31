import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonlReader, JsonlWriter } from "../../services/pi-runtime/src/jsonl.ts";
import { FakeRuntimePort } from "../../services/pi-runtime/src/fake-runtime.ts";
import { RuntimeWorker } from "../../services/pi-runtime/src/worker.ts";

class MemoryWritable extends EventEmitter {
  readonly lines: string[] = [];
  write(chunk: string): boolean {
    this.lines.push(chunk);
    return true;
  }
  frames(): any[] {
    return this.lines.flatMap((chunk) =>
      chunk
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
  }
}

const initialize = {
  protocolVersion: 3,
  kind: "command",
  id: "init",
  method: "runtime.initialize",
  params: {
    protocol: { minVersion: 3, maxVersion: 3 },
    workerId: "worker-test",
    runtimeGeneration: 3,
  },
};

const pinnedPolicyParams = {
  sessionPolicy: {
    sessionTitle: { effort: "minimal", maxWords: 6, fallback: "heuristic" },
    compaction: { enabled: true, thresholdPercent: 90 },
    modelProfiles: [
      { name: "sol-low", provider: "openai-codex", model: "gpt-5.6-sol", effort: "low" },
    ],
  },
  policyProvenance: {},
};

function command(id: string, method: string, params: unknown) {
  return { protocolVersion: 3, kind: "command", id, method, params };
}

test("JSONL reader uses LF framing and keeps Unicode separators inside JSON strings", async () => {
  const values: unknown[] = [];
  const malformed: string[] = [];
  const reader = new JsonlReader({
    onValue(value) {
      values.push(value);
    },
    onMalformed(reason) {
      malformed.push(reason);
    },
  });
  reader.push(`${JSON.stringify({ text: "one\u2028two" })}\r\n`);
  reader.push("not-json\n");
  await reader.end();
  assert.deepEqual(values, [{ text: "one\u2028two" }]);
  assert.deepEqual(malformed, ["Input line is not valid JSON."]);
});

test("worker enforces initialization, unique IDs, and unsupported command responses", async () => {
  const output = new MemoryWritable();
  const worker = new RuntimeWorker(new FakeRuntimePort(), new JsonlWriter(output), () => {});
  await worker.handleValue(command("early", "session.dispose", {}));
  await worker.handleValue(initialize);
  await worker.handleValue(initialize);
  await worker.handleValue(command("future", "future.method", {}));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await output.frames();

  const responses = output.frames().filter((frame) => frame.kind === "response");
  assert.deepEqual(
    responses.map((frame) => frame.error?.code ?? "ok"),
    ["initialization_required", "ok", "duplicate_command_id", "unsupported_command"],
  );
});

test("worker rejects session creation without pinned policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-policy-required-"));
  const output = new MemoryWritable();
  const worker = new RuntimeWorker(new FakeRuntimePort(), new JsonlWriter(output), () => {});
  await worker.handleValue(initialize);
  await worker.handleValue(
    command("create", "session.create", {
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      faux: true,
    }),
  );
  const response = output.frames().find((frame) => frame.id === "create");
  assert.equal(response.error?.code, "invalid_params");
});

test("worker rejects a protocol v1 supervisor after the required-policy version bump", async () => {
  const output = new MemoryWritable();
  const worker = new RuntimeWorker(new FakeRuntimePort(), new JsonlWriter(output), () => {});
  await worker.handleValue({
    ...initialize,
    protocolVersion: 1,
    id: "old-init",
    params: {
      ...initialize.params,
      protocol: { minVersion: 1, maxVersion: 1 },
    },
  });
  assert.equal(
    output.frames().find((frame) => frame.id === "old-init")?.error?.code,
    "protocol_version_mismatch",
  );
});

test("worker exposes typed workspace relocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-capability-"));
  const output = new MemoryWritable();
  const worker = new RuntimeWorker(new FakeRuntimePort(), new JsonlWriter(output), () => {});
  await worker.handleValue(initialize);
  await worker.handleValue(
    command("create", "session.create", {
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      ...pinnedPolicyParams,
      faux: true,
    }),
  );
  await worker.handleValue(
    command("relocate", "session.relocate_workspace", {
      backend: "jj",
      name: "focused",
    }),
  );
  const frames = output.frames();
  assert.ok(
    frames.some((frame) => frame.id === "relocate" && frame.result.cwd.endsWith("focused")),
  );
});

test("worker accepts a prompt without blocking cancellation and returns to idle", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-worker-"));
  const output = new MemoryWritable();
  const worker = new RuntimeWorker(new FakeRuntimePort(), new JsonlWriter(output), () => {});
  await worker.handleValue(initialize);
  await worker.handleValue(
    command("create", "session.create", {
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      ...pinnedPolicyParams,
      faux: true,
    }),
  );
  await worker.handleValue(command("prompt", "session.prompt", { turnId: "turn-1", text: "slow" }));
  assert.equal(worker.currentState(), "turn_active");
  await worker.handleValue(command("cancel", "session.cancel", { turnId: "turn-1" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(worker.currentState(), "session_idle");

  const frames = output.frames();
  assert.ok(frames.some((frame) => frame.id === "prompt" && frame.ok === true));
  assert.ok(frames.some((frame) => frame.event === "session.interrupted"));
  assert.ok(frames.some((frame) => frame.event === "session.idle"));
});
