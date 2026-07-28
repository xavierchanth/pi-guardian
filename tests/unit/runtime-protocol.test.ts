import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  RuntimeDecodeError,
  RuntimeEventSchema,
  RuntimeResponseSchema,
  decodeMethodParams,
  decodeRuntimeCommand,
  errorResponse,
  isRuntimeMethod,
  successResponse,
} from "../../packages/runtime-protocol/src/index.ts";

const fixtureRoot = resolve(import.meta.dirname, "../../fixtures/runtime-protocol");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(fixtureRoot, name), "utf8"));

test("Zod consumes shared runtime fixtures and method-specific parameters", () => {
  const command = decodeRuntimeCommand(fixture("initialize-command.json"));
  assert.equal(command.method, "runtime.initialize");
  assert.deepEqual(decodeMethodParams(command.method, command.params), {
    protocol: { minVersion: 2, maxVersion: 2 },
    workerId: "worker-1",
    runtimeGeneration: 7,
  });
  assert.equal(RuntimeResponseSchema.parse(fixture("initialize-response.json")).ok, true);
  assert.equal(RuntimeEventSchema.parse(fixture("text-delta-event.json")).event, "assistant.text_delta");
  assert.deepEqual(decodeMethodParams("session.set_capability", {
    capabilityId: "jj-workspaces",
    enabled: true,
  }), { capabilityId: "jj-workspaces", enabled: true });
  assert.deepEqual(decodeMethodParams("session.relocate_workspace", {
    backend: "git",
    name: "focused-task",
  }), { backend: "git", name: "focused-task" });
});

test("session create policy round trips through strict method schemas", () => {
  const policy = {
    sessionTitle: { effort: "minimal", maxWords: 6, fallback: "heuristic" },
    compaction: { enabled: true, thresholdPercent: 90 },
    modelProfiles: [
      { name: "sol-low", provider: "openai-codex", model: "gpt-5.6-sol", effort: "low" },
    ],
  };
  const provenance = {
    "sessionPolicy.compaction.enabled": { layer: "default" },
  };
  assert.deepEqual(decodeMethodParams("session.create", {
    cwd: "/tmp/project",
    agentDir: "/tmp/agent",
    sessionDir: "/tmp/sessions",
    sessionPolicy: policy,
    policyProvenance: provenance,
  }), {
    cwd: "/tmp/project",
    rootSessionId: null,
    runtimeGeneration: null,
    agentDir: "/tmp/agent",
    sessionDir: "/tmp/sessions",
    sessionPolicy: policy,
    policyProvenance: provenance,
  });
  assert.throws(
    () => decodeMethodParams("session.create", {
      cwd: "/tmp/project",
      agentDir: "/tmp/agent",
      sessionDir: "/tmp/sessions",
      sessionPolicy: { ...policy, compaction: { enabled: true, thresholdPercent: 500 } },
      policyProvenance: provenance,
    }),
    RuntimeDecodeError,
  );
});

test("generic envelopes preserve unsupported methods while known params validate separately", () => {
  const command = decodeRuntimeCommand({
    protocolVersion: 2,
    kind: "command",
    id: "unknown-1",
    method: "future.method",
    params: { anything: true },
  });
  assert.equal(isRuntimeMethod(command.method), false);
  assert.deepEqual(decodeMethodParams(command.method, command.params), { anything: true });

  assert.throws(
    () => decodeMethodParams("session.prompt", { turnId: "turn-1", text: "ok", extra: true }),
    (error: unknown) => error instanceof RuntimeDecodeError && error.code === "invalid_params",
  );
});

test("runtime schemas reject unknown fields, unsafe counters, and invalid response combinations", () => {
  assert.throws(() => decodeRuntimeCommand(fixture("invalid-extra-field.json")), RuntimeDecodeError);
  assert.equal(RuntimeEventSchema.safeParse(fixture("invalid-unsafe-sequence.json")).success, false);
  assert.equal(RuntimeResponseSchema.safeParse({
    protocolVersion: 2,
    kind: "response",
    id: "bad",
    ok: false,
  }).success, false);
});

test("response constructors validate outbound frames", () => {
  assert.deepEqual(successResponse("ok-1", {}), {
    protocolVersion: 2,
    kind: "response",
    id: "ok-1",
    ok: true,
    result: {},
  });
  assert.deepEqual(errorResponse("bad-1", {
    code: "unsupported_command",
    message: "Unsupported command.",
    retryable: false,
  }), {
    protocolVersion: 2,
    kind: "response",
    id: "bad-1",
    ok: false,
    error: {
      code: "unsupported_command",
      message: "Unsupported command.",
      retryable: false,
    },
  });
});
