import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BackendRegistry,
  type SubagentBackend,
} from "../../packages/pi-tai/src/core/subagents/backend.ts";
import { StubBackend } from "../../packages/pi-tai/src/core/subagents/backends/stub.ts";
import type { WorkspaceRecord } from "../../packages/pi-tai/src/core/isolation/domain.ts";
import type { WorkspaceManagerPort } from "../../packages/pi-tai/src/core/isolation/workspace-manager-port.ts";
import { IsolatedSubagents } from "../../packages/pi-tai/src/core/subagents/isolated.ts";
import type {
  LifecycleEvent,
  SubagentLifecycleStore,
} from "../../packages/pi-tai/src/core/subagents/lifecycle.ts";
import { foldLifecycle } from "../../packages/pi-tai/src/core/subagents/lifecycle.ts";
import { SubagentManager } from "../../packages/pi-tai/src/core/subagents/manager.ts";

const durableId = "550e8400-e29b-41d4-a716-446655440099";
const at = "2026-01-01T00:00:00.000Z";

function runningFacts(displayId = "sa-1"): LifecycleEvent[] {
  return [
    {
      version: 2,
      type: "spawn_intent",
      durableId,
      displayId,
      sequence: 1,
      generation: 1,
      backend: "pi",
      title: "restored",
      rootSessionId: "root-1",
      backendConfig: {},
      workspace: { cwd: "/virtual/work", workspaceId: "ws-1" },
      at,
    },
    { version: 2, type: "running", durableId, generation: 1, at },
  ];
}

class WorkspaceFixture implements WorkspaceManagerPort {
  readonly records: WorkspaceRecord[];
  constructor(records: WorkspaceRecord[]) {
    this.records = records;
  }
  async list() {
    return this.records;
  }
  async get(id: string) {
    return this.records.find((record) => record.id === id);
  }
  async create(): Promise<WorkspaceRecord> {
    throw new Error("unused");
  }
  async pendingChanges() {
    return [];
  }
  async assignOwner() {}
  async merge(): Promise<never> {
    throw new Error("unused");
  }
  async discard() {
    return { discardedChangeIds: [] };
  }
  async sweep() {
    return [];
  }
}

function workspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    version: 2,
    id: "ws-1",
    name: "managed",
    path: "/virtual/work",
    repoRoot: "/virtual/repo",
    phase: "active",
    baseChangeIds: [],
    rootChangeId: "change-1",
    ownerId: durableId,
    ownerDisplayId: "sa-1",
    rootSessionId: "root-1",
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

async function restoredManager(events = runningFacts()) {
  const manager = new SubagentManager({
    registry: new BackendRegistry([new StubBackend()]),
    rootSessionId: "root-1",
  });
  await manager.attachLifecycleStore({ load: async () => events, append: async () => {} });
  return manager;
}

describe("MG-1 durable continuation regressions", () => {
  it("rejects display-id-only custody restoration", async () => {
    const manager = await restoredManager();
    const workspaces = new WorkspaceFixture([workspace({ ownerId: "different-durable-owner" })]);
    const isolated = new IsolatedSubagents({
      agents: manager,
      workspaces,
      sourcePath: "/virtual/repo",
    });

    await isolated.restoreCustody();

    assert.equal(isolated.workspaceFor("sa-1"), undefined);
    assert.equal(manager.unresolvedCustody().length, 1);
  });

  it("restores exact active custody and resolves exact historical custody", async () => {
    for (const phase of ["active", "detached", "merged", "abandoned", "missing"] as const) {
      const manager = await restoredManager();
      const isolated = new IsolatedSubagents({
        agents: manager,
        workspaces: new WorkspaceFixture([workspace({ phase })]),
        sourcePath: "/virtual/repo",
      });
      await isolated.restoreCustody();
      assert.equal(isolated.workspaceFor("sa-1"), phase === "active" ? "ws-1" : undefined);
      assert.equal(manager.unresolvedCustody().length, 0);
      assert.equal(manager.get("sa-1")?.attention, true, "custody does not clear orphan attention");
    }
  });

  it("leaves absent, ambiguous, incident, and list-failure custody unresolved", async () => {
    for (const records of [[], [workspace(), workspace()], [workspace({ phase: "incident" })]]) {
      const manager = await restoredManager();
      const isolated = new IsolatedSubagents({
        agents: manager,
        workspaces: new WorkspaceFixture(records),
        sourcePath: "/virtual/repo",
      });
      await isolated.restoreCustody();
      assert.equal(manager.unresolvedCustody().length, 1);
    }
    const manager = await restoredManager();
    const failing = new WorkspaceFixture([]);
    failing.list = async () => {
      throw new Error("database unavailable");
    };
    const isolated = new IsolatedSubagents({
      agents: manager,
      workspaces: failing,
      sourcePath: "/virtual/repo",
    });
    await assert.rejects(() => isolated.restoreCustody(), /database unavailable/);
    assert.equal(manager.unresolvedCustody().length, 1);
  });

  it("durably downgrades a spawn failure to a terminal failed run", async () => {
    const events: LifecycleEvent[] = [];
    const store: SubagentLifecycleStore = {
      load: async () => events,
      append: async (event) => void events.push(event),
    };
    const backend: SubagentBackend = {
      name: "pi",
      capabilities: {
        liveInput: [],
        settledContinuation: "none",
        modelSelection: true,
        reasoningEffort: true,
      },
      available: async () => ({ ok: true }),
      spawn: async () => {
        throw new Error("synthetic spawn failure");
      },
    };
    const manager = new SubagentManager({
      registry: new BackendRegistry([backend]),
      lifecycleStore: store,
    });

    await assert.rejects(
      () =>
        manager.spawn({
          backend: "pi",
          prompt: "work",
          systemPrompt: "charter",
          cwd: "/virtual/work",
          title: "worker",
        }),
      /synthetic spawn failure/,
    );

    const folded = foldLifecycle(events);
    assert.equal(folded.rejected.length, 0);
    assert.equal([...folded.records.values()][0]?.disposition, "failed");
  });

  it("marks a running record orphaned on reload", async () => {
    const manager = await restoredManager();
    const snapshot = manager.get("sa-1");

    assert.equal(snapshot?.status, "error");
    assert.equal(snapshot?.attention, true);
    assert.match(snapshot?.errorText ?? "", /ownership is unproved after reload/);
  });
});
