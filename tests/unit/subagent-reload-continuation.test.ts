import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { WorkspaceRecord } from "../../packages/pi-tai/src/core/isolation/domain.ts";
import type { WorkspaceManagerPort } from "../../packages/pi-tai/src/core/isolation/workspace-manager-port.ts";
import { BackendRegistry } from "../../packages/pi-tai/src/core/subagents/backend.ts";
import { StubBackend } from "../../packages/pi-tai/src/core/subagents/backends/stub.ts";
import { IsolatedSubagents } from "../../packages/pi-tai/src/core/subagents/isolated.ts";
import type { LifecycleEvent } from "../../packages/pi-tai/src/core/subagents/lifecycle.ts";
import { foldLifecycle } from "../../packages/pi-tai/src/core/subagents/lifecycle.ts";
import { SubagentManager } from "../../packages/pi-tai/src/core/subagents/manager.ts";

const durableId = "550e8400-e29b-41d4-a716-446655440088";
const at = "2026-01-01T00:00:00.000Z";

class PhaseWorkspaceFixture implements WorkspaceManagerPort {
  private readonly record: WorkspaceRecord;
  constructor(record: WorkspaceRecord) {
    this.record = record;
  }
  async list() {
    return [this.record];
  }
  async get() {
    return this.record;
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

function terminalFacts(
  cwd: string,
  overrides: {
    rootSessionId?: string;
    tools?: readonly string[];
    handle?: boolean;
    backend?: "claude" | "pi";
    workspaceId?: string;
  } = {},
): LifecycleEvent[] {
  const backend = overrides.backend ?? "claude";
  return [
    {
      version: 2,
      type: "spawn_intent",
      durableId,
      displayId: "sa-8",
      sequence: 8,
      generation: 1,
      backend,
      title: "retained",
      rootSessionId: overrides.rootSessionId ?? "root-1",
      backendConfig: { tools: overrides.tools },
      workspace: { cwd, ...(overrides.workspaceId ? { workspaceId: overrides.workspaceId } : {}) },
      at,
    },
    { version: 2, type: "running", durableId, generation: 1, at },
    ...(overrides.handle === false
      ? []
      : ([
          {
            version: 2,
            type: "resume_handle_discovered",
            durableId,
            generation: 1,
            resumeHandle: { kind: "claude_session", value: "opaque-test-token" },
            at,
          },
        ] as LifecycleEvent[])),
    { version: 2, type: "terminal", durableId, generation: 1, disposition: "done", at },
  ];
}

async function setup(
  cwd: string,
  facts = terminalFacts(cwd),
  backend = new StubBackend({ name: "claude" }),
  additionalBackends: StubBackend[] = [],
) {
  const events = [...facts];
  const manager = new SubagentManager({
    registry: new BackendRegistry([backend, ...additionalBackends]),
    rootSessionId: "root-1",
    lifecycleStore: { load: async () => events, append: async (event) => void events.push(event) },
  });
  await manager.attachLifecycleStore({
    load: async () => events,
    append: async (event) => void events.push(event),
  });
  return { manager, backend, events };
}

describe("reloaded continuation", () => {
  it("auto mode refuses before availability or spawn", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pitai-reload-"));
    try {
      let availability = 0;
      const backend = new StubBackend({ name: "claude" });
      backend.available = async () => {
        availability++;
        return { ok: true };
      };
      const { manager } = await setup(cwd, terminalFacts(cwd), backend);
      await assert.rejects(() => manager.send("sa-8", "continue"), /only explicit mode:'continue'/);
      assert.equal(availability, 0);
      assert.equal(backend.spawned.length, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("continues Claude with the persisted handle, original cwd and foldable generation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pitai-reload-"));
    try {
      const { manager, backend, events } = await setup(
        cwd,
        terminalFacts(cwd, { workspaceId: "ws-active" }),
      );
      manager.resolveCustody("sa-8", false);
      await manager.send("sa-8", "continue", "continue");
      await manager.wait(["sa-8"]);
      assert.equal(backend.spawned[0]?.cwd, cwd);
      assert.equal(backend.spawned[0]?.resumeToken, "opaque-test-token");
      const folded = foldLifecycle(events);
      assert.equal(folded.rejected.length, 0);
      assert.equal(folded.records.get(durableId)?.generation, 2);
      assert.equal(folded.records.get(durableId)?.disposition, "done");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("refuses every local identity, handle, config, cwd and orphan gate before backend probes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pitai-reload-"));
    const file = join(cwd, "not-directory");
    await writeFile(file, "x");
    try {
      const cases: { facts: LifecycleEvent[]; pattern: RegExp; registerPi?: boolean }[] = [
        {
          facts: terminalFacts(cwd, { rootSessionId: "other-root" }),
          pattern: /belongs to a different root session/,
        },
        {
          facts: terminalFacts(cwd, { handle: false }),
          pattern: /has no expected continuation handle/,
        },
        {
          facts: terminalFacts(cwd, { tools: ["read"] }),
          pattern: /cannot prove the retained tool configuration/,
        },
        { facts: terminalFacts(file), pattern: /cannot prove its retained workspace directory/ },
        {
          facts: terminalFacts(join(cwd, "missing")),
          pattern: /cannot prove its retained workspace directory/,
        },
        {
          facts: terminalFacts(cwd, { backend: "pi" }),
          pattern: /pi backend cannot be reopened after reload/,
          registerPi: true,
        },
        {
          facts: terminalFacts(cwd).slice(0, -1),
          pattern: /has unproved live ownership after reload/,
        },
      ];
      for (const { facts, pattern, registerPi } of cases) {
        let availability = 0;
        const backend = new StubBackend({ name: "claude" });
        backend.available = async () => {
          availability++;
          return { ok: true };
        };
        const pi = new StubBackend({ name: "pi" });
        const { manager } = await setup(cwd, facts, backend, registerPi ? [pi] : []);
        await assert.rejects(() => manager.send("sa-8", "continue", "continue"), pattern);
        assert.equal(availability, 0);
        assert.equal(backend.spawned.length, 0);
        assert.equal(pi.spawned.length, 0);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("wires active and retired phases through custody restoration before continuation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pitai-reload-"));
    try {
      for (const phase of ["active", "detached", "merged", "abandoned", "missing"] as const) {
        let availability = 0;
        const backend = new StubBackend({ name: "claude" });
        backend.available = async () => {
          availability++;
          return { ok: true };
        };
        const workspaceId = `ws-${phase}`;
        const { manager } = await setup(cwd, terminalFacts(cwd, { workspaceId }), backend);
        const record: WorkspaceRecord = {
          version: 2,
          id: workspaceId,
          name: "retained",
          path: cwd,
          repoRoot: cwd,
          phase,
          baseChangeIds: [],
          rootChangeId: "change-1",
          ownerId: durableId,
          ownerDisplayId: "sa-8",
          rootSessionId: "root-1",
          createdAt: at,
          updatedAt: at,
        };
        const isolated = new IsolatedSubagents({
          agents: manager,
          workspaces: new PhaseWorkspaceFixture(record),
          sourcePath: cwd,
        });
        await isolated.restoreCustody();

        if (phase === "active") {
          await manager.send("sa-8", "continue", "continue");
          await manager.wait(["sa-8"]);
          assert.equal(availability, 1);
          assert.equal(backend.spawned.length, 1);
        } else {
          await assert.rejects(
            () => manager.send("sa-8", "continue", "continue"),
            /has retired workspace custody/,
            phase,
          );
          assert.equal(availability, 0, phase);
          assert.equal(backend.spawned.length, 0, phase);
        }
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not spawn or fabricate a terminal when the running lifecycle write fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pitai-reload-"));
    try {
      const events = terminalFacts(cwd);
      const backend = new StubBackend({ name: "claude" });
      const store = {
        load: async () => events,
        append: async (event: LifecycleEvent) => {
          if (event.generation === 2 && event.type === "running") throw new Error("write failed");
          events.push(event);
        },
      };
      const manager = new SubagentManager({
        registry: new BackendRegistry([backend]),
        rootSessionId: "root-1",
        lifecycleStore: store,
      });
      await manager.attachLifecycleStore(store);
      await assert.rejects(() => manager.send("sa-8", "continue", "continue"), /write failed/);
      assert.equal(backend.spawned.length, 0);
      assert.deepEqual(
        events.filter((event) => event.generation === 2).map((event) => event.type),
        ["generation_advanced"],
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("writes running then failed when backend spawn fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pitai-reload-"));
    try {
      const backend = new StubBackend({ name: "claude" });
      backend.spawn = async () => {
        throw new Error("spawn failed");
      };
      const { manager, events } = await setup(cwd, terminalFacts(cwd), backend);
      await assert.rejects(() => manager.send("sa-8", "continue", "continue"), /spawn failed/);
      const generation = events
        .filter((event) => event.generation === 2)
        .map((event) => event.type);
      assert.deepEqual(generation, ["generation_advanced", "running", "terminal"]);
      assert.equal(foldLifecycle(events).records.get(durableId)?.disposition, "failed");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
