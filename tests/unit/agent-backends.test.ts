import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ClaudeBackend,
  type ClaudeSdk,
} from "../../packages/pi-tai/src/core/subagents/backends/claude.ts";
import type { SpawnTask, SubagentEvent } from "../../packages/pi-tai/src/core/subagents/domain.ts";

function task(overrides: Partial<SpawnTask> = {}): SpawnTask {
  return {
    id: "sa-1",
    prompt: "do the thing",
    systemPrompt: "you are a worker",
    cwd: "/tmp/ws",
    title: "worker",
    ...overrides,
  };
}

/** An SDK double that replays a scripted message stream. */
function fakeSdk(
  messages: unknown[],
  onOptions?: (options: Record<string, unknown>) => void,
): ClaudeSdk {
  return {
    query({ options }) {
      onOptions?.(options ?? {});
      return {
        async *[Symbol.asyncIterator]() {
          for (const message of messages) yield message;
        },
      };
    },
  };
}

async function collect(events: AsyncIterable<SubagentEvent>): Promise<SubagentEvent[]> {
  const seen: SubagentEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

describe("claude backend", () => {
  it("reports itself unavailable rather than throwing when the SDK is absent", async () => {
    const backend = new ClaudeBackend({
      load: async () => {
        throw new Error("Cannot find module");
      },
    });

    const availability = await backend.available();

    assert.equal(availability.ok, false);
    assert.match(availability.ok === false ? availability.reason : "", /not installed/);
  });

  it("passes the workspace as cwd and the role prompt as the system prompt", async () => {
    let captured: Record<string, unknown> = {};
    const backend = new ClaudeBackend({
      load: async () =>
        fakeSdk([], (options) => {
          captured = options;
        }),
    });

    const session = await backend.spawn(task({ cwd: "/tmp/managed-ws", model: "claude-opus-5" }));
    await collect(session.events);

    assert.equal(captured.cwd, "/tmp/managed-ws");
    assert.equal(captured.systemPrompt, "you are a worker");
    assert.equal(captured.model, "claude-opus-5");
    assert.equal(captured.permissionMode, "bypassPermissions");
  });

  it("translates an SDK run into assistant, tool and settle events", async () => {
    const backend = new ClaudeBackend({
      load: async () =>
        fakeSdk([
          { type: "system", subtype: "init", model: "claude-opus-5" },
          {
            type: "assistant",
            message: {
              content: [
                { type: "text", text: "reading the file" },
                { type: "tool_use", id: "t1", name: "Read", input: {} },
              ],
              usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
            },
          },
          {
            type: "user",
            message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
          },
          { type: "result", subtype: "success", result: "done: added the feature" },
        ]),
    });

    const session = await backend.spawn(task());
    const events = await collect(session.events);

    assert.deepEqual(
      events.map((event) => event.type),
      [
        "run_started",
        "meta",
        "assistant_message",
        "tool_start",
        "usage",
        "tool_end",
        "run_settled",
      ],
    );
    const usage = events.find((event) => event.type === "usage");
    assert.equal(
      usage?.type === "usage" && usage.inputTokens,
      105,
      "cache reads count toward input",
    );
    const settled = events.at(-1);
    assert.equal(settled?.type === "run_settled" && settled.outcome, "completed");
    assert.equal(settled?.type === "run_settled" && settled.text, "done: added the feature");
  });

  it("settles as failed when the SDK reports an error result", async () => {
    const backend = new ClaudeBackend({
      load: async () =>
        fakeSdk([
          {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            result: "tool crashed",
          },
        ]),
    });

    const session = await backend.spawn(task());
    const events = await collect(session.events);

    const settled = events.at(-1);
    assert.equal(settled?.type === "run_settled" && settled.outcome, "failed");
    assert.equal(settled?.type === "run_settled" && settled.error, "tool crashed");
  });

  it("settles as failed when the SDK stream throws", async () => {
    const backend = new ClaudeBackend({
      load: async () => ({
        query() {
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: "system" };
              throw new Error("connection reset");
            },
          };
        },
      }),
    });

    const session = await backend.spawn(task());
    const events = await collect(session.events);

    const settled = events.at(-1);
    assert.equal(settled?.type === "run_settled" && settled.outcome, "failed");
    assert.equal(settled?.type === "run_settled" && settled.error, "connection reset");
  });

  it("captures the session id so a settled run can be continued", async () => {
    const backend = new ClaudeBackend({
      load: async () =>
        fakeSdk([
          { type: "system", subtype: "init", session_id: "sess-abc", model: "claude-fable-5" },
          { type: "result", subtype: "success", result: "here is the design" },
        ]),
    });

    const session = await backend.spawn(task());
    await collect(session.events);

    assert.equal(session.resumeToken, "sess-abc");
    assert.equal(backend.capabilities.resumable, true);
  });

  it("passes the resume token back to the SDK on a follow-up turn", async () => {
    let captured: Record<string, unknown> = {};
    const backend = new ClaudeBackend({
      load: async () =>
        fakeSdk([], (options) => {
          captured = options;
        }),
    });

    const session = await backend.spawn(
      task({ prompt: "what about auth?", resumeToken: "sess-abc" }),
    );
    await collect(session.events);

    assert.equal(captured.resume, "sess-abc");
  });

  it("accepts a string content payload as assistant text", async () => {
    const backend = new ClaudeBackend({
      load: async () =>
        fakeSdk([{ type: "assistant", message: { content: "plain string reply" } }]),
    });

    const session = await backend.spawn(task());
    const events = await collect(session.events);

    const message = events.find((event) => event.type === "assistant_message");
    assert.equal(message?.type === "assistant_message" && message.text, "plain string reply");
  });
});
