import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionCapabilityController } from "../../packages/pi-tai/src/capabilities/controller.ts";
import { CAPABILITY_STATE_ENTRY } from "../../packages/pi-tai/src/capabilities/domain.ts";

test("capability leases separate service availability from model tool exposure", async () => {
  let active = ["read", "dynamic"];
  const persisted: string[][] = [];
  const controller = new SessionCapabilityController();
  controller.bindTools({
    getActiveTools: () => [...active],
    setActiveTools: (next) => {
      active = [...next];
    },
  });
  controller.bindPersistence((enabled) => persisted.push([...enabled]));
  controller.register({
    id: "jj-workspaces",
    label: "JJ Workspaces",
    description: "Create isolated JJ workspaces",
    toolNames: ["create_jj_workspace", "jj_workspace_status"],
  });

  await controller.enable("jj-workspaces", {
    owner: "feature:subagents",
    exposure: "service-only",
  });
  assert.equal(controller.isServiceEnabled("jj-workspaces"), true);
  assert.equal(controller.isToolExposed("jj-workspaces"), false);
  assert.deepEqual(active, ["read", "dynamic"]);

  await controller.enable("jj-workspaces", { owner: "user", exposure: "model-tools" });
  assert.deepEqual(active, ["read", "dynamic", "create_jj_workspace", "jj_workspace_status"]);
  assert.deepEqual(persisted, [["jj-workspaces"]]);

  controller.disable("jj-workspaces", "feature:subagents");
  assert.equal(controller.isToolExposed("jj-workspaces"), true);
  controller.disable("jj-workspaces", "user");
  assert.deepEqual(active, ["read", "dynamic"]);
  assert.deepEqual(persisted.at(-1), []);
});

test("capability reconstruction resets forks and preserves resumed user intent", () => {
  let active = ["read"];
  const controller = new SessionCapabilityController();
  controller.bindTools({
    getActiveTools: () => [...active],
    setActiveTools: (next) => {
      active = [...next];
    },
  });
  controller.register({
    id: "git-worktrees",
    label: "Git Worktrees",
    description: "Create isolated Git worktrees",
    toolNames: ["create_git_worktree"],
  });
  const entries = [
    {
      type: "custom",
      id: "entry",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      customType: CAPABILITY_STATE_ENTRY,
      data: { enabled: ["git-worktrees"] },
    },
  ] as SessionEntry[];

  controller.reconstruct(entries, false);
  assert.deepEqual(active, ["read", "create_git_worktree"]);
  controller.reconstruct(entries, true);
  assert.deepEqual(active, ["read"]);
});

test("capability probes reject unavailable backends before acquiring a lease", async () => {
  const controller = new SessionCapabilityController();
  controller.register({
    id: "jj-workspaces",
    label: "JJ Workspaces",
    description: "Create isolated JJ workspaces",
    probe: async () => ({ available: false, reason: "not a JJ repository" }),
  });
  await assert.rejects(
    controller.enable("jj-workspaces", { owner: "user", exposure: "model-tools" }),
    /not a JJ repository/,
  );
  assert.equal(controller.isServiceEnabled("jj-workspaces"), false);
});
