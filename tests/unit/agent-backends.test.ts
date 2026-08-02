import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SendNotDeliveredError } from "../../packages/pi-tai/src/core/subagents/backend.ts";
import {
  ClaudeBackend,
  type ClaudeSdk,
} from "../../packages/pi-tai/src/core/subagents/backends/claude.ts";
import { ClaudeInputQueue } from "../../packages/pi-tai/src/core/subagents/backends/claude-input-queue.ts";
import { PiBackend } from "../../packages/pi-tai/src/core/subagents/backends/pi.ts";
import { StubBackend } from "../../packages/pi-tai/src/core/subagents/backends/stub.ts";
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
    query({ prompt, options }) {
      onOptions?.(options ?? {});
      return {
        async *[Symbol.asyncIterator]() {
          // The real SDK consumes streaming input concurrently with output.
          // Pulling before replaying result frames makes this double detect an
          // accidentally string-based prompt and exercises queue settlement.
          const iterator = typeof prompt === "string" ? undefined : prompt[Symbol.asyncIterator]();
          await iterator?.next();
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

describe("pi backend", () => {
  it("passes explicit steer behavior for a running send", async () => {
    const prompts: unknown[][] = [];
    const session = {
      isStreaming: true,
      prompt: async (...args: unknown[]) => void prompts.push(args),
      waitForIdle: async () => new Promise<void>(() => {}),
      subscribe: () => () => {},
    };
    const backend = new PiBackend({
      config: {} as never,
      modelRegistry: {} as never,
      stateRoot: "/tmp/state",
      factory: {
        create: async () =>
          ({
            contextId: "sa-1",
            session,
            sessionId: "session-1",
            sessionFile: "/tmp/session.jsonl",
            sessionDir: "/tmp",
            bridge: {},
            send() {},
            async abort() {},
            async waitForIdle() {},
            dispose() {},
          }) as never,
      },
    });

    const child = await backend.spawn(task());
    await child.send("new direction", "steer");

    assert.deepEqual(prompts[1], ["new direction", { streamingBehavior: "steer" }]);
    child.dispose();
  });

  it("continues a settled session in place and rejects a second writer", async () => {
    const prompts: string[] = [];
    let streaming = false;
    let release!: () => void;
    const session = {
      get isStreaming() {
        return streaming;
      },
      prompt: async (text: string) => {
        prompts.push(text);
        if (prompts.length > 1) {
          streaming = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          streaming = false;
        }
      },
      waitForIdle: async () => {},
      subscribe: () => () => {},
    };
    const backend = new PiBackend({
      config: {} as never,
      modelRegistry: {} as never,
      stateRoot: "/tmp/state",
      factory: {
        create: async () =>
          ({
            session,
            sessionFile: "/tmp/session.jsonl",
            async abort() {},
            dispose() {},
          }) as never,
      },
    });

    const child = await backend.spawn(task());
    await collect(child.events);
    await child.continueInPlace?.("second turn");
    await assert.rejects(child.continueInPlace!("racing turn"), SendNotDeliveredError);
    release();
    const continuation = await collect(child.events);

    assert.deepEqual(prompts, ["do the thing", "second turn"]);
    assert.deepEqual(
      continuation.map((event) => event.type),
      ["run_started", "run_settled"],
    );
    child.dispose();
  });

  it("isolates subscriptions and settlement across in-place generations", async () => {
    const subscribers: Array<(event: unknown) => void> = [];
    const unsubscribed: number[] = [];
    const idleResolvers: Array<() => void> = [];
    let prompts = 0;
    const session = {
      isStreaming: false,
      prompt: async () => void prompts++,
      waitForIdle: () =>
        new Promise<void>((resolve) => {
          idleResolvers.push(resolve);
        }),
      subscribe: (subscriber: (event: unknown) => void) => {
        const index = subscribers.push(subscriber) - 1;
        return () => void unsubscribed.push(index);
      },
    };
    const backend = new PiBackend({
      config: {} as never,
      modelRegistry: {} as never,
      stateRoot: "/tmp/state",
      factory: {
        create: async () =>
          ({ session, sessionFile: "/tmp/session.jsonl", async abort() {}, dispose() {} }) as never,
      },
    });

    const child = await backend.spawn(task());
    const oldEvents = child.events;
    await child.continueInPlace?.("second");
    const newEvents = child.events;
    assert.notEqual(oldEvents, newEvents);

    idleResolvers[0]?.();
    await new Promise((resolve) => setImmediate(resolve));
    subscribers[0]?.({ type: "message_end", message: { role: "assistant", content: "old" } });
    subscribers[1]?.({ type: "message_end", message: { role: "assistant", content: "new" } });
    idleResolvers[1]?.();
    const continuation = await collect(newEvents);

    assert.equal(prompts, 2);
    assert.ok(unsubscribed.includes(0), "the old completion only unsubscribes its own generation");
    assert.deepEqual(
      continuation.filter((event) => event.type === "assistant_message"),
      [{ type: "assistant_message", text: "new" }],
    );
    assert.equal(continuation.at(-1)?.type, "run_settled");
    child.dispose();
  });

  it("rejects an idle send as not delivered without prompting", async () => {
    const prompts: unknown[][] = [];
    const session = {
      isStreaming: false,
      prompt: async (...args: unknown[]) => void prompts.push(args),
      waitForIdle: async () => new Promise<void>(() => {}),
      subscribe: () => () => {},
    };
    const backend = new PiBackend({
      config: {} as never,
      modelRegistry: {} as never,
      stateRoot: "/tmp/state",
      factory: {
        create: async () =>
          ({
            contextId: "sa-1",
            session,
            sessionId: "session-1",
            sessionFile: "/tmp/session.jsonl",
            sessionDir: "/tmp",
            bridge: {},
            send() {},
            async abort() {},
            async waitForIdle() {},
            dispose() {},
          }) as never,
      },
    });

    const child = await backend.spawn(task());
    await assert.rejects(child.send("too late", "steer"), SendNotDeliveredError);
    assert.deepEqual(prompts, [["do the thing"]]);
    child.dispose();
  });
});

describe("stub backend", () => {
  it("models steer, follow-up and continuation distinctly and narrows transcripts by id", async () => {
    const backend = new StubBackend({ settledContinuation: "respawn" });
    const first = await backend.spawn(task({ id: "same", prompt: "first" }));
    await collect(first.events);
    await first.send("live", "steer");
    await first.send("queued", "followUp");
    const other = await backend.spawn(task({ id: "other", prompt: "secret-other-session" }));
    await collect(other.events);
    const resumed = await backend.spawn(task({ id: "same", prompt: "second" }));
    await collect(resumed.events);
    await resumed.send("again", "continue");

    assert.deepEqual(
      backend.sends.map(({ mode, phase }) => ({ mode, phase })),
      [
        { mode: "steer", phase: "settled" },
        { mode: "followUp", phase: "settled" },
        { mode: "continue", phase: "settled" },
      ],
    );
    assert.ok(
      !backend.spawned
        .filter((entry) => entry.id === "same")
        .some((entry) => entry.prompt.includes("secret")),
    );
  });

  it("reports typed refusal reasons without recording delivery", async () => {
    const backend = new StubBackend({ sendBehaviour: () => "saturated" });
    const session = await backend.spawn(task({ prompt: "HANG:" }));
    await assert.rejects(
      session.send("no room", "followUp"),
      (error: unknown) => error instanceof SendNotDeliveredError && error.reason === "saturated",
    );
    assert.equal(backend.sends.length, 0);
  });
});

describe("claude input queue", () => {
  it("is FIFO, assigns UUIDs, tracks bytes, and drains to an exact close", async () => {
    const queue = new ClaudeInputQueue();
    const firstUuid = queue.push("α");
    const secondUuid = queue.push("beta");
    assert.match(firstUuid, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
    assert.notEqual(firstUuid, secondUuid);
    assert.equal(queue.pendingBytes, Buffer.byteLength("αbeta"));
    const iterator = queue[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.message.content, "α");
    assert.equal(queue.lastYieldedUuid, firstUuid);
    assert.equal((await iterator.next()).value?.message.content, "beta");
    queue.close();
    queue.close();
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
    assert.throws(() => queue.push("late"), SendNotDeliveredError);
  });

  it("enforces message and UTF-8 byte bounds and rejects an interrupted waiter", async () => {
    const countBound = new ClaudeInputQueue();
    for (let index = 0; index < ClaudeInputQueue.maxMessages; index++) countBound.push("x");
    assert.throws(
      () => countBound.push("overflow"),
      (error: unknown) => error instanceof SendNotDeliveredError && error.reason === "saturated",
    );

    const byteBound = new ClaudeInputQueue();
    byteBound.push("x".repeat(ClaudeInputQueue.maxBytes));
    assert.throws(() => byteBound.push("é"), SendNotDeliveredError);

    const interrupted = new ClaudeInputQueue();
    const waiting = interrupted[Symbol.asyncIterator]().next();
    interrupted.failAll("closed");
    await assert.rejects(waiting, SendNotDeliveredError);
  });
});

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
    assert.equal(backend.capabilities.settledContinuation, "respawn");
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
