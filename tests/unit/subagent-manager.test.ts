import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BackendRegistry } from "../../packages/pi-tai/src/agents/backend.ts";
import { StubBackend } from "../../packages/pi-tai/src/agents/backends/stub.ts";
import { applyEvent, contextUtilisation, emptySnapshot } from "../../packages/pi-tai/src/agents/domain.ts";
import { SubagentManager } from "../../packages/pi-tai/src/agents/manager.ts";

function managerWith(backends: StubBackend[], options: { maxRunning?: number; onSettled?: (snapshot: any) => void } = {}) {
  const registry = new BackendRegistry(backends);
  return new SubagentManager({
    registry,
    ...(options.maxRunning !== undefined ? { maxRunning: options.maxRunning } : {}),
    ...(options.onSettled ? { onSettled: options.onSettled } : {}),
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
  it("returns partial results on user interruption without cancelling pending agents", async () => {
    const backend = new StubBackend();
    const manager = managerWith([backend]);
    const settledAgent = await manager.spawn(request({ prompt: "quick" }));
    const pendingAgent = await manager.spawn(request({ prompt: "HANG: later" }));
    await manager.wait([settledAgent.id]);

    const interruption = new AbortController();
    const waiting = manager.wait([settledAgent.id, pendingAgent.id], undefined, interruption.signal);
    interruption.abort();
    const result = await waiting;

    assert.equal(result.reason, "user-interrupted");
    assert.deepEqual(result.settled.map(({ id }) => id), [settledAgent.id]);
    assert.deepEqual(result.pending, [pendingAgent.id]);
    assert.equal(manager.get(pendingAgent.id)?.status, "running");
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

  it("spawns and settles, exposing the child's final text", async () => {
    const manager = managerWith([new StubBackend()]);

    const spawned = await manager.spawn(request());
    const [settled] = await manager.wait([spawned.id]);

    assert.equal(settled?.status, "done");
    assert.equal(settled?.finalText, "done: do the thing");
    assert.equal(settled?.turns, 1);
  });

  it("records failures as errors without throwing at the spawn site", async () => {
    const manager = managerWith([new StubBackend()]);

    const spawned = await manager.spawn(request({ prompt: "FAIL: no such file" }));
    const [settled] = await manager.wait([spawned.id]);

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
    assert.deepEqual(manager.delivery.drain().map((result) => result.id), [second.id]);
  });

  it("runs the settle hook exactly once per subagent", async () => {
    const settledIds: string[] = [];
    const manager = managerWith([new StubBackend()], { onSettled: (snapshot) => { settledIds.push(snapshot.id); } });

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
    const [settled] = await manager.wait([spawned.id]);

    assert.equal(settled?.id, spawned.id, "the follow-up keeps the same subagent id");
    assert.equal(settled?.finalText, "done: what about the auth case?");
    assert.equal(backend.spawned.length, 2, "a follow-up is a second run, not a held process");
    assert.equal(backend.spawned[1]?.resumeToken, `stub-session-${spawned.id}`, "context carries via the resume token");
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

  it("refuses to continue a settled subagent on a harness that cannot resume", async () => {
    const backend = new StubBackend();
    (backend as { capabilities: Record<string, boolean> }).capabilities = {
      steering: false, modelSelection: true, reasoningEffort: false, resumable: false,
    };
    const manager = managerWith([backend]);

    const spawned = await manager.spawn(request());
    await manager.wait([spawned.id]);

    await assert.rejects(manager.send(spawned.id, "follow up"), /cannot continue it; spawn a new subagent/);
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

    await assert.rejects(manager.spawn(request({ backend: "claude" })), /unavailable: SDK not installed/);
  });

  it("does not consume a concurrency slot when the spawn itself fails", async () => {
    const manager = managerWith([new StubBackend()], { maxRunning: 1 });

    await assert.rejects(manager.spawn(request({ backend: "claude" })));
    const spawned = await manager.spawn(request());

    assert.equal(spawned.status, "running");
  });
});

describe("snapshot folding", () => {
  const base = emptySnapshot({ id: "sa-1", backend: "pi", title: "t", cwd: "/tmp", createdAt: "now" });

  it("accumulates streaming deltas into the latest text", () => {
    const streamed = ["Hel", "lo"].reduce(
      (snapshot, text) => applyEvent(snapshot, { type: "assistant_delta", text }, "now"),
      base,
    );

    assert.equal(streamed.latestText, "Hello");
    assert.equal(streamed.finalText, "", "an unfinished stream is not a final answer");
  });

  it("reports context utilisation only when the window is known", () => {
    const withoutWindow = applyEvent(base, { type: "usage", inputTokens: 10, outputTokens: 10 }, "now");
    const withWindow = applyEvent(base, { type: "usage", inputTokens: 50, outputTokens: 50, contextWindow: 1_000 }, "now");

    assert.equal(contextUtilisation(withoutWindow), undefined);
    assert.equal(contextUtilisation(withWindow), 10);
  });

  it("bounds error text so one broken child cannot flood the parent", () => {
    const settled = applyEvent(base, { type: "run_settled", outcome: "failed", error: "x".repeat(10_000) }, "now");

    assert.ok(Buffer.byteLength(settled.errorText ?? "", "utf8") <= 4096 + 3);
  });
});

/** Lets the manager's post-settle microtasks (hook then defer) run. */
function settleQueue(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
