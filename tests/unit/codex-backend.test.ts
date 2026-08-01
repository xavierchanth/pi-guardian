import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CodexBackend } from "../../packages/pi-tai/src/core/subagents/backends/codex.ts";
import { researchAvailability } from "../../packages/pi-tai/src/core/subagents/backends/codex-protocol.ts";
import type { SpawnTask, SubagentEvent } from "../../packages/pi-tai/src/core/subagents/domain.ts";

/**
 * A stand-in for `codex app-server` that speaks the same newline-delimited
 * JSON-RPC. It lets these tests pin the handshake and notification mapping
 * without depending on a Codex install or a model call.
 */
const FAKE_SERVER = String.raw`#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log("codex 0.0.0-test"); process.exit(0); }
const readline = require("node:readline");
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const notify = (method, params) => send({ method, params });
const scenario = process.env.FAKE_CODEX_SCENARIO || "success";
let turnId = "turn-1";
let started = false;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method === "initialize") return send({ id: frame.id, result: { userAgent: "fake" } });
  if (frame.method === "modelProvider/capabilities/read") return send({ id: frame.id, result: {
    webSearch: scenario !== "no-web", imageGeneration: false, namespaceTools: false,
  } });
  if (frame.method === "configRequirements/read") return send({ id: frame.id, result: {
    requirements: scenario === "policy" ? { allowedWebSearchModes: ["cached"] } : null,
  } });
  if (frame.method === "thread/resume") {
    send({ id: frame.id, result: { thread: { id: frame.params.threadId } } });
    process.stderr.write("resumed thread=" + frame.params.threadId + "\n");
    return;
  }
  if (frame.method === "thread/start") {
    send({ id: frame.id, result: { thread: { id: "thread-1", cwd: frame.params.cwd } } });
    process.stderr.write("started with cwd=" + frame.params.cwd
      + " instructions=" + frame.params.developerInstructions
      + " sandbox=" + frame.params.sandbox
      + " approval=" + frame.params.approvalPolicy
      + " web_search=" + (frame.params.config && frame.params.config.web_search) + "\n");
    return;
  }
  if (frame.method === "turn/start") {
    if (started) {
      process.stderr.write("turn on " + frame.params.threadId + ": " + frame.params.input[0].text + "\n");
      return send({ id: frame.id, result: { turnId } });
    }
    started = true;
    send({ id: frame.id, result: { turnId } });
    notify("turn/started", { threadId: "thread-1", turn: { id: turnId, status: "inProgress", items: [] } });
    if (scenario === "research") {
      notify("item/started", { threadId: "thread-1", turnId, item: { id: "web-1", type: "webSearch", query: "current facts" } });
      notify("item/completed", { threadId: "thread-1", turnId, item: { id: "web-1", type: "webSearch", query: "current facts", results: [] } });
    }
    notify("item/started", { threadId: "thread-1", turnId, item: { id: "i1", type: "commandExecution", command: "ls -la" } });
    notify("item/completed", { completedAtMs: 1, threadId: "thread-1", turnId, item: { id: "i1", type: "commandExecution", status: "completed" } });
    notify("item/agentMessage/delta", { threadId: "thread-1", turnId, itemId: "i2", delta: "wor" });
    notify("item/agentMessage/delta", { threadId: "thread-1", turnId, itemId: "i2", delta: "king" });
    notify("thread/tokenUsage/updated", { threadId: "thread-1", turnId, tokenUsage: {
      modelContextWindow: 200000,
      last: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 15 },
      total: { inputTokens: 900, cachedInputTokens: 100, outputTokens: 50, reasoningOutputTokens: 0, totalTokens: 1050 },
    } });
    notify("item/completed", { completedAtMs: 2, threadId: "thread-1", turnId, item: { id: "i2", type: "agentMessage", text: "finished the task" } });
    if (scenario === "failure") {
      notify("turn/completed", { threadId: "thread-1", turn: { id: turnId, status: "failed", items: [], error: { message: "model unavailable" } } });
    } else if (scenario !== "hang") {
      notify("turn/completed", { threadId: "thread-1", turn: { id: turnId, status: "completed", items: [] } });
    }
    return;
  }
  if (frame.method === "turn/interrupt") {
    send({ id: frame.id, result: {} });
    notify("turn/completed", { threadId: "thread-1", turn: { id: frame.params.turnId, status: "interrupted", items: [] } });
    return;
  }
  if (frame.method === "turn/steer") {
    return send({ id: frame.id, result: {} });
  }
});
`;

let root: string;
let binary: string;

function task(overrides: Partial<SpawnTask> = {}): SpawnTask {
  return {
    id: "sa-1",
    prompt: "do the thing",
    systemPrompt: "you are a worker",
    cwd: process.cwd(),
    title: "worker",
    ...overrides,
  };
}

async function collect(events: AsyncIterable<SubagentEvent>): Promise<SubagentEvent[]> {
  const seen: SubagentEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

describe("codex protocol capability mapping", () => {
  const supported = { webSearch: true, imageGeneration: false, namespaceTools: false };

  it("distinguishes unsupported provider support from policy restrictions", () => {
    const unsupported = researchAvailability(
      { ...supported, webSearch: false },
      { requirements: null },
    );
    const policy = researchAvailability(supported, {
      requirements: { allowedWebSearchModes: ["cached"] },
    });
    assert.equal(unsupported.ok, false);
    assert.equal(!unsupported.ok && unsupported.kind, "unsupported");
    assert.equal(policy.ok, false);
    assert.equal(!policy.ok && policy.kind, "policy");
  });

  it("permits live search when requirements are absent or explicitly allow it", () => {
    assert.deepEqual(researchAvailability(supported, { requirements: null }), { ok: true });
    assert.deepEqual(
      researchAvailability(supported, { requirements: { allowedWebSearchModes: ["live"] } }),
      { ok: true },
    );
  });
});

describe("codex backend", () => {
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-tai-codex-"));
    binary = join(root, "fake-codex");
    await writeFile(binary, FAKE_SERVER);
    await chmod(binary, 0o755);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
    delete process.env.FAKE_CODEX_SCENARIO;
  });

  it("reports a missing binary as unavailable instead of throwing", async () => {
    const backend = new CodexBackend({ binary: join(root, "definitely-not-installed") });

    const availability = await backend.available();

    assert.equal(availability.ok, false);
    assert.match(availability.ok === false ? availability.reason : "", /not on PATH/);
  });

  it("reports an installed binary as available", async () => {
    assert.deepEqual(await new CodexBackend({ binary }).available(), { ok: true });
  });

  it("completes the handshake and folds notifications into neutral events", async () => {
    delete process.env.FAKE_CODEX_SCENARIO;
    const backend = new CodexBackend({ binary });

    const session = await backend.spawn(task());
    const events = await collect(session.events);

    assert.deepEqual(
      events.map((event) => event.type),
      [
        "run_started",
        "tool_start",
        "tool_end",
        "assistant_delta",
        "assistant_delta",
        "usage",
        "assistant_message",
        "run_settled",
      ],
    );
    const usage = events.find((event) => event.type === "usage");
    assert.equal(
      usage?.type === "usage" && usage.inputTokens,
      1000,
      "cached input counts toward input tokens",
    );
    assert.equal(usage?.type === "usage" && usage.contextWindow, 200_000);
    const settled = events.at(-1);
    assert.equal(settled?.type === "run_settled" && settled.outcome, "completed");
    assert.equal(settled?.type === "run_settled" && settled.text, "finished the task");
  });

  it("carries the workspace cwd, role prompt and headless policy into thread/start", async () => {
    delete process.env.FAKE_CODEX_SCENARIO;
    const backend = new CodexBackend({ binary });
    const session = await backend.spawn(task({ cwd: root }));
    const stderr = captureStderr(session);
    await collect(session.events);

    const text = await stderr;
    assert.match(text, new RegExp(`cwd=${root}`));
    assert.match(text, /instructions=you are a worker/);
    assert.match(text, /sandbox=workspace-write/);
    assert.match(text, /approval=never/, "a headless child cannot answer approval prompts");
  });

  it("probes and explicitly enables live native search for researchers", async () => {
    process.env.FAKE_CODEX_SCENARIO = "research";
    const session = await new CodexBackend({ binary }).spawn(task({ capability: "researcher" }));
    const stderr = captureStderr(session);
    const events = await collect(session.events);

    assert.match(await stderr, /web_search=live/);
    const web = events.filter((event) => event.type === "tool_start" || event.type === "tool_end");
    assert.ok(
      web.some(
        (event) =>
          event.type === "tool_start" &&
          event.name === "web_search" &&
          event.preview === "current facts",
      ),
    );
  });

  it("fails a researcher before starting a thread when native search is unsupported", async () => {
    process.env.FAKE_CODEX_SCENARIO = "no-web";
    await assert.rejects(
      new CodexBackend({ binary }).spawn(task({ capability: "researcher" })),
      /Researcher unavailable:.*does not support native web search/,
    );
  });

  it("fails a researcher clearly when policy blocks live search", async () => {
    process.env.FAKE_CODEX_SCENARIO = "policy";
    await assert.rejects(
      new CodexBackend({ binary }).spawn(task({ capability: "researcher" })),
      /Researcher unavailable:.*policy blocks live web search/,
    );
  });

  it("exposes the thread id so a settled subagent can be continued", async () => {
    delete process.env.FAKE_CODEX_SCENARIO;
    const backend = new CodexBackend({ binary });

    const session = await backend.spawn(task());
    await collect(session.events);

    assert.equal(session.resumeToken, "thread-1");
    assert.equal(backend.capabilities.resumable, true);
  });

  it("continues an existing thread instead of starting a new one", async () => {
    delete process.env.FAKE_CODEX_SCENARIO;
    const backend = new CodexBackend({ binary });

    const session = await backend.spawn(task({ prompt: "follow up", resumeToken: "thread-1" }));
    const stderr = captureStderr(session);
    await collect(session.events);

    const text = await stderr;
    assert.match(text, /resumed thread=thread-1/);
    assert.doesNotMatch(text, /started with cwd/, "a resumed subagent is not re-briefed");
  });

  it("settles as failed when the turn reports an error", async () => {
    process.env.FAKE_CODEX_SCENARIO = "failure";
    const backend = new CodexBackend({ binary });

    const session = await backend.spawn(task());
    const events = await collect(session.events);

    const settled = events.at(-1);
    assert.equal(settled?.type === "run_settled" && settled.outcome, "failed");
    assert.equal(settled?.type === "run_settled" && settled.error, "model unavailable");
  });

  it("interrupts an in-flight turn", async () => {
    process.env.FAKE_CODEX_SCENARIO = "hang";
    const backend = new CodexBackend({ binary });

    const session = await backend.spawn(task());
    const settled = collect(session.events);
    await waitFor(() => true);
    await session.interrupt();

    const events = await settled;
    const last = events.at(-1);
    assert.equal(last?.type === "run_settled" && last.outcome, "interrupted");
  });

  it("rejects a running send without starting a concurrent turn", async () => {
    process.env.FAKE_CODEX_SCENARIO = "hang";
    const backend = new CodexBackend({ binary });

    const session = await backend.spawn(task());
    const stderr = captureStderr(session);
    await waitFor(() => true);
    await assert.rejects(session.send("also update the docs"), /does not support steering/);
    await session.interrupt();
    await collect(session.events);

    const text = await stderr;
    assert.doesNotMatch(text, /turn on thread-1:/);
  });
});

/** Collects the fake server's stderr, which is how it reports what it received. */
function captureStderr(session: unknown): Promise<string> {
  const child = (session as { child: { stderr: NodeJS.ReadableStream } }).child;
  let text = "";
  child.stderr.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  return new Promise((resolve) => setTimeout(() => resolve(text), 250));
}

function waitFor(check: () => boolean): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(() => {
      check();
      resolve();
    }, 150),
  );
}
