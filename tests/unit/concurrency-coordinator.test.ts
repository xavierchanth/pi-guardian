import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  PrivateChildSessionFactoryPort,
  PrivateChildSessionHandle,
  PrivateChildSessionRequest,
} from "../../packages/pi-tai/src/concurrency/child-session.ts";
import { ChildContextCoordinator } from "../../packages/pi-tai/src/concurrency/coordinator.ts";
import { FileChildContextStore } from "../../packages/pi-tai/src/concurrency/persistence.ts";
import type { AgentDefinitionSnapshot } from "../../packages/pi-tai/src/subagents/store.ts";

function snapshot(name: string, allowedChildren: string[] = []): AgentDefinitionSnapshot {
  return {
    name, description: name, root: name === "thinker", provider: "faux", model: "scripted", effort: "low",
    tools: [], allowedChildren, uncertaintyHandling: "best-effort", systemPrompt: name,
    source: "packaged", filePath: `${name}.md`, contentHash: "hash",
  };
}

class FakeFactory implements PrivateChildSessionFactoryPort {
  readonly requests: PrivateChildSessionRequest[] = [];
  readonly handles = new Map<string, FakeHandle>();
  private readonly handleFactory: (contextId: string) => FakeHandle;
  constructor(handleFactory: (contextId: string) => FakeHandle = (contextId) => new FakeHandle(contextId)) {
    this.handleFactory = handleFactory;
  }
  async create(request: PrivateChildSessionRequest): Promise<PrivateChildSessionHandle> {
    this.requests.push(request);
    const handle = this.handleFactory(request.contextId);
    this.handles.set(request.contextId, handle);
    return handle as unknown as PrivateChildSessionHandle;
  }
}

class FakeHandle {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly sessionDir = "/private";
  readonly bridge = {} as ExtensionAPI;
  readonly sent: unknown[] = [];
  aborted = false;
  disposed = false;
  readonly session: Pick<AgentSession, "prompt" | "subscribe">;
  readonly contextId: string;
  constructor(contextId: string) {
    this.contextId = contextId;
    this.sessionId = `session-${contextId}`;
    this.sessionFile = `/private/${contextId}.jsonl`;
    this.session = { prompt: async () => undefined, subscribe: () => () => {} };
  }
  send(message: unknown): void { this.sent.push(message); }
  async abort(): Promise<void> { this.aborted = true; }
  async waitForIdle(): Promise<void> {}
  dispose(): void { this.disposed = true; }
}

class DeferredAbortHandle extends FakeHandle {
  private resolveAbort!: () => void;
  private readonly abortedPromise = new Promise<void>((resolve) => { this.resolveAbort = resolve; });
  override async abort(): Promise<void> {
    this.aborted = true;
    await this.abortedPromise;
  }
  settle(): void { this.resolveAbort(); }
}

test("root-scoped coordinator persists intent before starting private contexts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-coordinator-"));
  const factory = new FakeFactory();
  const ids = ["child-1", "cycle-1", "child-2", "cycle-2"];
  const coordinator = new ChildContextCoordinator({
    store: new FileChildContextStore(join(root, "records")), sessionFactory: factory,
    stateRoot: root, agentDir: join(root, "agent"), id: () => ids.shift()!, now: () => "2026-01-01T00:00:00Z",
  });
  const registry = {} as ExtensionContext["modelRegistry"];
  const first = await coordinator.spawn({
    rootSessionId: "root-a", cwd: "/repo", task: { objective: "first", uncertaintyHandling: "best-effort" },
    caller: snapshot("thinker", ["worker"]), agent: snapshot("worker"), modelRegistry: registry,
  });
  const second = await coordinator.spawn({
    rootSessionId: "root-b", cwd: "/repo", task: { objective: "second", uncertaintyHandling: "best-effort" },
    caller: snapshot("thinker", ["worker"]), agent: snapshot("worker"), modelRegistry: registry,
  });
  assert.equal(first.execution.phase, "running");
  assert.equal(second.execution.phase, "running");
  assert.deepEqual((await coordinator.children("root-a")).map((item) => item.contextId), ["child-1"]);
  assert.deepEqual((await coordinator.children("root-b")).map((item) => item.contextId), ["child-2"]);
  assert.equal(factory.requests.length, 2);
  assert.equal((factory.handles.get("child-1")?.sent[0] as { customType?: string })?.customType, "pi-tai-task-v1");

  await coordinator.disposeRoot("root-a");
  assert.equal(factory.handles.get("child-1")?.aborted, true);
  assert.equal(factory.handles.get("child-2")?.aborted, false);
  assert.equal((await coordinator.get("child-1"))?.execution.phase, "interrupted");
});

test("explicit cancellation terminates one cycle and preserves sibling runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-coordinator-cancel-"));
  const factory = new FakeFactory();
  const ids = ["child-1", "cycle-1", "child-2", "cycle-2", "event-1"];
  const coordinator = new ChildContextCoordinator({
    store: new FileChildContextStore(join(root, "records")), sessionFactory: factory,
    stateRoot: root, agentDir: root, id: () => ids.shift()!, now: () => "2026-01-01T00:00:00Z",
  });
  const request = {
    rootSessionId: "root", cwd: "/repo", caller: snapshot("thinker", ["worker"]), agent: snapshot("worker"),
    modelRegistry: {} as ExtensionContext["modelRegistry"],
  };
  await coordinator.spawn({ ...request, task: { objective: "one", uncertaintyHandling: "best-effort" } });
  await coordinator.spawn({ ...request, task: { objective: "two", uncertaintyHandling: "best-effort" } });
  const cancellation = await coordinator.cancel("child-1");
  assert.equal(cancellation.disposition, "cancelled");
  const cancelled = cancellation.contexts.find((context) => context.contextId === "child-1");
  assert.equal(cancelled?.execution.phase, "cancelled");
  assert.equal(cancelled?.events[0]?.delivery.phase, "persisted");
  assert.equal(factory.handles.get("child-1")?.disposed, true);
  assert.ok(coordinator.getRuntime("child-2"));
});

test("cancellation returns pending instead of hanging on a non-cooperative child, then finalizes after quiescence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-coordinator-pending-cancel-"));
  const factory = new FakeFactory((contextId) => new DeferredAbortHandle(contextId));
  const ids = ["child-1", "cycle-1", "event-1"];
  const coordinator = new ChildContextCoordinator({
    store: new FileChildContextStore(join(root, "records")), sessionFactory: factory,
    stateRoot: root, agentDir: root, id: () => ids.shift()!, now: () => "2026-01-01T00:00:00Z",
    cancellationGraceMs: 1,
  });
  await coordinator.spawn({
    rootSessionId: "root", cwd: "/repo", caller: snapshot("thinker", ["worker"]), agent: snapshot("worker"),
    modelRegistry: {} as ExtensionContext["modelRegistry"], task: { objective: "one", uncertaintyHandling: "best-effort" },
  });

  const cancellation = await coordinator.cancel("child-1");
  assert.equal(cancellation.disposition, "pending");
  assert.deepEqual(cancellation.pendingContextIds, ["child-1"]);
  assert.equal((await coordinator.get("child-1"))?.execution.phase, "cancelling");
  assert.equal(factory.handles.get("child-1")?.disposed, false);

  (factory.handles.get("child-1") as DeferredAbortHandle).settle();
  let cancelled = await coordinator.get("child-1");
  for (let attempt = 0; attempt < 20 && cancelled?.execution.phase !== "cancelled"; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    cancelled = await coordinator.get("child-1");
  }
  assert.equal(cancelled?.execution.phase, "cancelled");
  assert.equal(cancelled?.events.filter((event) => event.kind === "terminal").length, 1);
  assert.equal(factory.handles.get("child-1")?.disposed, true);
  assert.equal(coordinator.getRuntime("child-1"), undefined);
});

test("root disposal is bounded when a child ignores abort", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-coordinator-pending-dispose-"));
  const factory = new FakeFactory((contextId) => new DeferredAbortHandle(contextId));
  const ids = ["child-1", "cycle-1"];
  const coordinator = new ChildContextCoordinator({
    store: new FileChildContextStore(join(root, "records")), sessionFactory: factory,
    stateRoot: root, agentDir: root, id: () => ids.shift()!, now: () => "2026-01-01T00:00:00Z",
    cancellationGraceMs: 1,
  });
  await coordinator.spawn({
    rootSessionId: "root", cwd: "/repo", caller: snapshot("thinker", ["worker"]), agent: snapshot("worker"),
    modelRegistry: {} as ExtensionContext["modelRegistry"], task: { objective: "one", uncertaintyHandling: "best-effort" },
  });

  await coordinator.disposeRoot("root");
  assert.equal((await coordinator.get("child-1"))?.execution.phase, "interrupted");
  assert.ok(coordinator.getRuntime("child-1"));
  (factory.handles.get("child-1") as DeferredAbortHandle).settle();
  for (let attempt = 0; attempt < 20 && coordinator.getRuntime("child-1"); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(coordinator.getRuntime("child-1"), undefined);
});

test("cancellation settles descendants before their parent and leaves siblings live", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-coordinator-cancel-tree-"));
  const factory = new FakeFactory();
  const ids = ["cycle-parent", "cycle-child", "cycle-sibling", "event-child", "event-parent"];
  const coordinator = new ChildContextCoordinator({
    store: new FileChildContextStore(join(root, "records")), sessionFactory: factory,
    stateRoot: root, agentDir: root, id: () => ids.shift()!, now: () => "2026-01-01T00:00:00Z",
  });
  const request = {
    rootSessionId: "root", cwd: "/repo", caller: snapshot("thinker", ["worker"]), agent: snapshot("worker"),
    modelRegistry: {} as ExtensionContext["modelRegistry"],
  };
  await coordinator.spawn({ ...request, contextId: "parent", task: { objective: "parent", uncertaintyHandling: "best-effort" } });
  await coordinator.spawn({ ...request, contextId: "child", parentContextId: "parent", task: { objective: "child", uncertaintyHandling: "best-effort" } });
  await coordinator.spawn({ ...request, contextId: "sibling", task: { objective: "sibling", uncertaintyHandling: "best-effort" } });

  const cancellation = await coordinator.cancel("parent");
  assert.equal(cancellation.disposition, "cancelled");
  assert.deepEqual(cancellation.contexts.map((context) => [context.contextId, context.execution.phase]), [
    ["child", "cancelled"],
    ["parent", "cancelled"],
  ]);
  assert.equal(factory.handles.get("sibling")?.aborted, false);
  assert.ok(coordinator.getRuntime("sibling"));
});

test("cancellation never rewrites an already terminal context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-coordinator-cancel-terminal-"));
  const store = new FileChildContextStore(join(root, "records"));
  const factory = new FakeFactory();
  const ids = ["cycle-1"];
  const coordinator = new ChildContextCoordinator({
    store, sessionFactory: factory, stateRoot: root, agentDir: root, id: () => ids.shift()!, now: () => "2026-01-01T00:00:00Z",
  });
  await coordinator.spawn({
    rootSessionId: "root", contextId: "child-1", cwd: "/repo", caller: snapshot("thinker", ["worker"]), agent: snapshot("worker"),
    modelRegistry: {} as ExtensionContext["modelRegistry"], task: { objective: "one", uncertaintyHandling: "best-effort" },
  });
  await store.update("child-1", (current) => ({
    ...current,
    execution: { phase: "completed", cycleId: "cycle-1", terminalEventId: "terminal-1", finishedAt: "done" },
    events: [{
      eventId: "terminal-1", contextId: "child-1", cycleId: "cycle-1", kind: "terminal",
      payload: { outcome: "completed", summary: "done" }, delivery: { phase: "persisted", createdAt: "done" },
    }],
  }));

  const cancellation = await coordinator.cancel("child-1");
  assert.equal(cancellation.disposition, "already_terminal");
  assert.equal((await coordinator.get("child-1"))?.execution.phase, "completed");
  assert.equal(factory.handles.get("child-1")?.aborted, false);
});
