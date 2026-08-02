import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BackendRegistry,
  SendNotDeliveredError,
  type SubagentBackend,
} from "../../packages/pi-tai/src/core/subagents/backend.ts";
import { StubBackend } from "../../packages/pi-tai/src/core/subagents/backends/stub.ts";
import {
  applyEvent,
  contextUtilisation,
  emptySnapshot,
} from "../../packages/pi-tai/src/core/subagents/domain.ts";
import type {
  LifecycleEvent,
  SubagentLifecycleStore,
} from "../../packages/pi-tai/src/core/subagents/lifecycle.ts";
import { foldLifecycle } from "../../packages/pi-tai/src/core/subagents/lifecycle.ts";
import { SubagentManager } from "../../packages/pi-tai/src/core/subagents/manager.ts";

function managerWith(
  backends: StubBackend[],
  options: {
    maxRunning?: number;
    onSettled?: (snapshot: any) => void;
    lifecycleStore?: SubagentLifecycleStore;
  } = {},
) {
  const registry = new BackendRegistry(backends);
  return new SubagentManager({
    registry,
    ...(options.maxRunning !== undefined ? { maxRunning: options.maxRunning } : {}),
    ...(options.onSettled ? { onSettled: options.onSettled } : {}),
    ...(options.lifecycleStore ? { lifecycleStore: options.lifecycleStore } : {}),
  });
}

function request(overrides: Partial<Parameters<SubagentManager["spawn"]>[0]> = {}) {
  return {
    backend: "pi" as const,
    prompt: "do the thing",
    systemPrompt: "you are a worker",
    cwd: "/tmp/work",
    title: "worker",
    ...overrides,
  };
}

describe("subagent manager", () => {
  it("keeps a run's lifecycle generation stable across branch navigation", async () => {
    const events: LifecycleEvent[] = [];
    const store: SubagentLifecycleStore = {
      load: async () => events,
      append: async (event) => void events.push(event),
    };
    const manager = new SubagentManager({
      registry: new BackendRegistry([new StubBackend()]),
      lifecycleStore: store,
    });
    const spawned = await manager.spawn(request({ prompt: "HANG: navigate" }));

    await manager.attachLifecycleStore(store);
    await manager.cancel([spawned.id]);

    const folded = foldLifecycle(events);
    assert.equal(folded.rejected.length, 0);
    assert.equal(folded.records.get(spawned.durableId)?.disposition, "interrupted");
  });

  it("does not replace a live entry when a sibling branch reuses its display ID", async () => {
    const manager = managerWith([new StubBackend()]);
    const live = await manager.spawn(request({ prompt: "HANG: live" }));
    const siblingIntent: LifecycleEvent = {
      version: 1,
      type: "spawn_intent",
      durableId: "550e8400-e29b-41d4-a716-446655440099",
      displayId: live.id,
      sequence: 1,
      generation: 4,
      backend: "pi",
      title: "sibling",
      cwd: "/tmp/sibling",
      at: "2026-01-01T00:00:00Z",
    };
    await manager.attachLifecycleStore({
      load: async () => [siblingIntent],
      append: async () => {},
    });

    assert.equal(manager.runningCount, 1);
    assert.equal(manager.get(live.id)?.durableId, live.durableId);
    const waiting = manager.wait([live.id]);
    await manager.cancel([live.id]);
    assert.equal((await waiting).settled[0]?.durableId, live.durableId);
  });

  it("returns on user interruption without cancelling pending agents", async () => {
    const manager = managerWith([new StubBackend()]);
    const first = await manager.spawn(request({ prompt: "HANG: first" }));
    const second = await manager.spawn(request({ prompt: "HANG: second" }));
    const interruption = new AbortController();
    const waiting = manager.wait([first.id, second.id], undefined, interruption.signal);

    interruption.abort();
    const result = await waiting;

    assert.equal(result.reason, "user-interrupted");
    assert.deepEqual(result.settled, []);
    assert.deepEqual(
      result.pending.map(({ id }) => id),
      [first.id, second.id],
    );
    assert.equal(manager.get(first.id)?.status, "running");
    assert.equal(manager.get(second.id)?.status, "running");
  });

  it("preserves settled partial results when foreground input interrupts", async () => {
    const manager = managerWith([new StubBackend()]);
    const first = await manager.spawn(request({ prompt: "HANG: first" }));
    const second = await manager.spawn(request({ prompt: "HANG: second" }));
    const interruption = new AbortController();
    const waiting = manager.wait([first.id, second.id], undefined, interruption.signal);

    await manager.cancel([first.id]);
    interruption.abort();
    const result = await waiting;

    assert.deepEqual(
      result.settled.map(({ id }) => id),
      [first.id],
    );
    assert.deepEqual(
      result.pending.map(({ id }) => id),
      [second.id],
    );
    assert.equal(manager.delivery.size, 0, "the returned partial result was consumed");
    assert.equal(manager.get(second.id)?.status, "running");
  });

  it("keeps tool cancellation a rejected wait and does not cancel the child", async () => {
    const manager = managerWith([new StubBackend()]);
    const agent = await manager.spawn(request({ prompt: "HANG: later" }));
    const cancellation = new AbortController();
    const waiting = manager.wait([agent.id], cancellation.signal);
    cancellation.abort();
    await assert.rejects(waiting, /Wait was cancelled/);
    assert.equal(manager.get(agent.id)?.status, "running");
  });

  it("does not consume settled results when cancellation precedes the wait", async () => {
    const manager = managerWith([new StubBackend()]);
    const agent = await manager.spawn(request());
    await settleQueue();
    const cancellation = new AbortController();
    cancellation.abort();

    await assert.rejects(manager.wait([agent.id], cancellation.signal), /Wait was cancelled/);
    assert.equal(manager.delivery.size, 1);
  });

  it("spawns and settles, exposing the child's final text", async () => {
    const manager = managerWith([new StubBackend()]);

    const spawned = await manager.spawn(request());
    const [settled] = (await manager.wait([spawned.id])).settled;

    assert.equal(settled?.status, "done");
    assert.equal(settled?.finalText, "done: do the thing");
    assert.equal(settled?.turns, 1);
  });

  it("records failures as errors without throwing at the spawn site", async () => {
    const manager = managerWith([new StubBackend()]);

    const spawned = await manager.spawn(request({ prompt: "FAIL: no such file" }));
    const [settled] = (await manager.wait([spawned.id])).settled;

    assert.equal(settled?.status, "error");
    assert.equal(settled?.errorText, "no such file");
  });

  it("enforces the concurrency cap against calls issued in one turn", async () => {
    const manager = managerWith([new StubBackend()], { maxRunning: 2 });

    // No awaits between spawns: this is the shape of a model emitting parallel
    // tool calls, and the reservation must hold without yielding first.
    const spawns = [
      manager.spawn(request({ prompt: "HANG: one" })),
      manager.spawn(request({ prompt: "HANG: two" })),
      manager.spawn(request({ prompt: "HANG: three" })),
    ];
    const outcomes = await Promise.allSettled(spawns);

    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 2);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    assert.match(String((rejected as PromiseRejectedResult).reason), /At most 2 subagents/);
  });

  it("frees a slot once a subagent settles", async () => {
    const manager = managerWith([new StubBackend()], { maxRunning: 1 });

    const first = await manager.spawn(request());
    await manager.wait([first.id]);
    const second = await manager.spawn(request());

    assert.equal(second.id, "sa-2");
  });

  it("defers results nobody waited on, and consumes them when wait does return them", async () => {
    const manager = managerWith([new StubBackend()]);

    const unattended = await manager.spawn(request({ prompt: "background" }));
    await manager.wait([unattended.id]);
    assert.equal(manager.delivery.size, 0, "wait consumes the result it returned");

    const second = await manager.spawn(request({ prompt: "also background" }));
    await settleQueue();
    assert.equal(manager.delivery.size, 1);
    assert.deepEqual(
      manager.delivery.drain().map((result) => result.id),
      [second.id],
    );
  });

  it("collects staggered completions with durable wait-any snapshots", async () => {
    const manager = managerWith([new StubBackend()]);
    const first = await manager.spawn(request({ prompt: "HANG: first" }));
    const second = await manager.spawn(request({ prompt: "HANG: second" }));

    const waiting = manager.wait([first.id, second.id]);
    await manager.cancel([first.id]);
    const one = await waiting;
    assert.deepEqual(
      one.settled.map((entry) => entry.id),
      [first.id],
    );
    assert.deepEqual(
      one.pending.map((entry) => entry.id),
      [second.id],
    );
    assert.equal(one.reason, "settled");
    assert.equal(manager.delivery.size, 0, "only the returned result was consumed");

    await manager.cancel([second.id]); // settles between wait calls
    assert.equal(manager.delivery.size, 1);
    const two = await manager.wait([first.id, second.id]);
    assert.deepEqual(
      two.settled.map((entry) => entry.id),
      [first.id, second.id],
    );
    assert.deepEqual(two.pending, []);
    assert.equal(manager.delivery.size, 0);
  });

  it("collects all completions visible when wait-any resumes", async () => {
    const manager = managerWith([new StubBackend()]);
    const first = await manager.spawn(request({ prompt: "HANG: first" }));
    const second = await manager.spawn(request({ prompt: "HANG: second" }));
    const waiting = manager.wait([first.id, second.id]);

    await manager.cancel([first.id, second.id]);
    const result = await waiting;
    assert.deepEqual(
      result.settled.map((entry) => entry.id),
      [first.id, second.id],
    );
    assert.deepEqual(result.pending, []);
  });

  it("deduplicates ids and reports all unknown ids without consuming valid results", async () => {
    const manager = managerWith([new StubBackend()]);
    const spawned = await manager.spawn(request());
    await settleQueue();
    await assert.rejects(
      manager.wait([spawned.id, "missing-a", "missing-b"]),
      /missing-a, missing-b/,
    );
    assert.equal(manager.delivery.size, 1);
    const result = await manager.wait([spawned.id, spawned.id]);
    assert.deepEqual(
      result.settled.map((entry) => entry.id),
      [spawned.id],
    );
    assert.deepEqual(result.pending, []);
  });

  it("runs the settle hook exactly once per subagent", async () => {
    const settledIds: string[] = [];
    const manager = managerWith([new StubBackend()], {
      onSettled: (snapshot) => {
        settledIds.push(snapshot.id);
      },
    });

    const spawned = await manager.spawn(request());
    await manager.wait([spawned.id]);
    await settleQueue();

    assert.deepEqual(settledIds, [spawned.id]);
  });

  it("settles a hung subagent on cancel and reports it as interrupted", async () => {
    const manager = managerWith([new StubBackend()]);

    const spawned = await manager.spawn(request({ prompt: "HANG: forever" }));
    assert.equal(manager.get(spawned.id)?.status, "running");
    const [cancelled] = await manager.cancel([spawned.id]);

    assert.equal(cancelled?.status, "error");
    assert.equal(cancelled?.errorText, "Run was aborted.");
    assert.equal(manager.runningCount, 0);
  });

  it("resumes a settled subagent as a follow-up run on the same id", async () => {
    const backend = new StubBackend();
    const manager = managerWith([backend]);

    const spawned = await manager.spawn(request({ prompt: "design the thing" }));
    await manager.wait([spawned.id]);
    await manager.send(spawned.id, "what about the auth case?");
    const [settled] = (await manager.wait([spawned.id])).settled;

    assert.equal(settled?.id, spawned.id, "the follow-up keeps the same subagent id");
    assert.equal(settled?.finalText, "done: what about the auth case?");
    assert.equal(backend.spawned.length, 2, "a follow-up is a second run, not a held process");
    assert.equal(
      backend.spawned[1]?.resumeToken,
      `stub-session-${spawned.id}`,
      "context carries via the resume token",
    );
  });

  it("reports an ordinary settled auto continuation without inventing a race", async () => {
    const manager = managerWith([new StubBackend()]);
    const spawned = await manager.spawn(request());
    await manager.wait([spawned.id]);

    assert.deepEqual(await manager.send(spawned.id, "next"), {
      operation: "continue",
      settlementRace: false,
    });
  });

  it("returns the typed auto settlement-race continuation receipt", async () => {
    const backend = new StubBackend();
    const spawn = backend.spawn.bind(backend);
    backend.spawn = async (task) => {
      const session = await spawn(task);
      session.send = async () => {
        await session.interrupt();
        await settleQueue();
        throw new SendNotDeliveredError("settled before delivery", "settled");
      };
      return session;
    };
    const manager = managerWith([backend], { maxRunning: 1 });
    const spawned = await manager.spawn(request({ prompt: "HANG: race" }));

    for (let generation = 0; generation < 3; generation += 1) {
      assert.deepEqual(await manager.send(spawned.id, `continue generation ${generation}`), {
        operation: "continue",
        settlementRace: true,
      });
      await manager.wait([spawned.id]);
      assert.equal(
        manager.capacity().running,
        0,
        "the refused run's reservation must not leak after its successor settles",
      );
      if (generation < 2) {
        await manager.send(spawned.id, `HANG: generation ${generation + 1}`);
        assert.equal(manager.get(spawned.id)?.status, "running");
      }
    }
  });

  it("persists a continuation running and terminal lifecycle", async () => {
    const events: LifecycleEvent[] = [];
    const store: SubagentLifecycleStore = {
      load: async () => events,
      append: async (event) => void events.push(event),
    };
    const manager = managerWith([new StubBackend()], { lifecycleStore: store });
    const spawned = await manager.spawn(request());
    await manager.wait([spawned.id]);
    await manager.send(spawned.id, "next");
    await manager.wait([spawned.id]);

    assert.deepEqual(
      events.map(({ type }) => type),
      ["spawn_intent", "running", "terminal", "running", "terminal"],
    );
    const folded = foldLifecycle(events);
    assert.equal(folded.rejected.length, 0);
    assert.equal(folded.records.get(spawned.durableId)?.disposition, "done");
  });

  it("does not tombstone a settled continuable entry when cancel is requested", async () => {
    const manager = managerWith([new StubBackend()]);
    const spawned = await manager.spawn(request());
    await manager.wait([spawned.id]);
    await manager.cancel([spawned.id]);

    await manager.send(spawned.id, "still continuable");
    assert.equal((await manager.wait([spawned.id])).settled[0]?.status, "done");
  });

  it("does not let a queued send resurrect an entry cancelled while waiting", async () => {
    const backend = new StubBackend();
    const manager = managerWith([backend]);
    let release!: () => void;
    const spawn = backend.spawn.bind(backend);
    backend.spawn = async (task) => {
      const session = await spawn(task);
      session.send = () =>
        new Promise<void>((resolve) => {
          release = resolve;
        });
      return session;
    };
    const spawned = await manager.spawn(request({ prompt: "HANG: forever" }));

    const first = manager.send(spawned.id, "one");
    const queued = manager.send(spawned.id, "two");
    const queuedRejected = assert.rejects(queued, /closed and cannot accept input/);
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    await manager.cancel([spawned.id]);
    release();
    await first;
    await queuedRejected;
    assert.equal(backend.spawned.length, 1);
  });

  it("fails a continuation closed when its running lifecycle write fails", async () => {
    let appends = 0;
    const store: SubagentLifecycleStore = {
      load: async () => [],
      append: async () => {
        appends += 1;
        if (appends === 4) throw new Error("disk full");
      },
    };
    const backend = new StubBackend();
    const manager = managerWith([backend], { lifecycleStore: store });
    const spawned = await manager.spawn(request());
    await manager.wait([spawned.id]);
    await assert.rejects(manager.send(spawned.id, "next"), /disk full/);
    assert.notEqual(manager.get(spawned.id)?.status, "running");
  });

  it("frees the concurrency slot again after a resumed run settles", async () => {
    const manager = managerWith([new StubBackend()], { maxRunning: 1 });

    const spawned = await manager.spawn(request());
    await manager.wait([spawned.id]);
    await manager.send(spawned.id, "follow up");
    await manager.wait([spawned.id]);

    assert.equal(manager.runningCount, 0);
    await manager.spawn(request());
  });

  it("refuses a non-steering backend before calling its running session", async () => {
    const backend = new StubBackend({ name: "codex" });
    (backend as { capabilities: SubagentBackend["capabilities"] }).capabilities = {
      liveInput: [],
      settledContinuation: "respawn",
      modelSelection: true,
      reasoningEffort: true,
    };
    let sends = 0;
    const spawn = backend.spawn.bind(backend);
    backend.spawn = async (task) => {
      const session = await spawn(task);
      session.send = async () => {
        sends += 1;
      };
      return session;
    };
    const manager = managerWith([backend]);
    const spawned = await manager.spawn(request({ backend: "codex", prompt: "HANG: running" }));

    await assert.rejects(
      manager.send(spawned.id, "new direction"),
      new Error(
        `Subagent ${spawned.id} is running, but the codex backend does not support live input.`,
      ),
    );
    assert.equal(sends, 0);
  });

  it("refuses to continue a settled subagent on a harness that cannot resume", async () => {
    const backend = new StubBackend();
    (backend as { capabilities: SubagentBackend["capabilities"] }).capabilities = {
      liveInput: [],
      settledContinuation: "none",
      modelSelection: true,
      reasoningEffort: false,
    };
    const manager = managerWith([backend]);

    const spawned = await manager.spawn(request());
    await manager.wait([spawned.id]);

    await assert.rejects(
      manager.send(spawned.id, "follow up"),
      /cannot continue its conversation; spawn a new subagent instead/,
    );
  });

  it("refuses backends that are not registered, naming what is available", async () => {
    const manager = managerWith([new StubBackend({ name: "pi" })]);

    await assert.rejects(manager.spawn(request({ backend: "codex" })), /not enabled.*pi/s);
  });

  it("refuses a registered backend that reports itself unavailable", async () => {
    const manager = managerWith([
      new StubBackend({ name: "pi" }),
      new StubBackend({ name: "claude", available: { ok: false, reason: "SDK not installed" } }),
    ]);

    await assert.rejects(
      manager.spawn(request({ backend: "claude" })),
      /unavailable: SDK not installed/,
    );
  });

  it("does not consume a concurrency slot when the spawn itself fails", async () => {
    const manager = managerWith([new StubBackend()], { maxRunning: 1 });

    await assert.rejects(manager.spawn(request({ backend: "claude" })));
    const spawned = await manager.spawn(request());

    assert.equal(spawned.status, "running");
  });
});

describe("snapshot folding", () => {
  const base = emptySnapshot({
    id: "sa-1",
    backend: "pi",
    title: "t",
    cwd: "/tmp",
    createdAt: "now",
  });

  it("accumulates streaming deltas into the latest text", () => {
    const streamed = ["Hel", "lo"].reduce(
      (snapshot, text) => applyEvent(snapshot, { type: "assistant_delta", text }, "now"),
      base,
    );

    assert.equal(streamed.latestText, "Hello");
    assert.equal(streamed.finalText, "", "an unfinished stream is not a final answer");
  });

  it("reports context utilisation only when the window is known", () => {
    const withoutWindow = applyEvent(
      base,
      { type: "usage", inputTokens: 10, outputTokens: 10 },
      "now",
    );
    const withWindow = applyEvent(
      base,
      { type: "usage", inputTokens: 50, outputTokens: 50, contextWindow: 1_000 },
      "now",
    );

    assert.equal(contextUtilisation(withoutWindow), undefined);
    assert.equal(contextUtilisation(withWindow), 10);
  });

  it("bounds error text so one broken child cannot flood the parent", () => {
    const settled = applyEvent(
      base,
      { type: "run_settled", outcome: "failed", error: "x".repeat(10_000) },
      "now",
    );

    assert.ok(Buffer.byteLength(settled.errorText ?? "", "utf8") <= 4096 + 3);
  });
});

/** Lets the manager's post-settle microtasks (hook then defer) run. */
function settleQueue(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
