import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SessionCapabilityController } from "../capabilities/controller.ts";
import { CAPABILITY_STATE_ENTRY } from "../capabilities/domain.ts";
import { reconstructSubagentState } from "../subagents/domain.ts";
import { FileDelegationStore, isResolvedDelegation, type DelegationStore } from "../subagents/store.ts";
import type { WorkspacePort } from "./domain.ts";
import { GitWorktreePort } from "./git.ts";
import { JjWorkspacePort } from "./jj.ts";
import {
  FileWorkspaceTransitionStore,
  type WorkspaceTransitionRecord,
  type WorkspaceTransitionStore,
} from "./store.ts";

const TRANSITION_ENTRY = "pi-tai-workspace-transition";

export interface WorkspaceCapabilityDependencies {
  capabilities: SessionCapabilityController;
  jj?: WorkspacePort;
  git?: WorkspacePort;
  transitions?: WorkspaceTransitionStore;
  delegations?: DelegationStore;
  stateRoot?: string;
}

export function registerWorkspaceCapabilities(
  pi: ExtensionAPI,
  dependencies: WorkspaceCapabilityDependencies,
): void {
  const capabilities = dependencies.capabilities;
  const agentDir = dependencies.stateRoot ?? getAgentDir();
  const stateRoot = join(agentDir, "pi-tai", "workspaces");
  const jj = dependencies.jj ?? new JjWorkspacePort();
  const git = dependencies.git ?? new GitWorktreePort(join(stateRoot, "git"));
  const transitions = dependencies.transitions
    ?? new FileWorkspaceTransitionStore(join(stateRoot, "transitions"));
  const delegations = dependencies.delegations
    ?? new FileDelegationStore(join(agentDir, "pi-tai", "subagents", "delegations"));
  let cwd = process.cwd();

  capabilities.register({
    id: "jj-workspaces",
    label: "JJ Workspaces",
    description: "Create or enter isolated JJ workspaces",
    toolNames: ["create_jj_workspace", "jj_workspace_status"],
    probe: () => jj.probe(cwd),
  });
  capabilities.register({
    id: "git-worktrees",
    label: "Git Worktrees",
    description: "Create or enter isolated Git worktrees",
    toolNames: ["create_git_worktree", "git_worktree_status"],
    probe: () => git.probe(cwd),
  });

  pi.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd;
  });

  pi.registerCommand("cap:jj-workspaces", {
    description: "Enable, inspect, create, or enter standalone JJ workspaces",
    handler: async (args, ctx) => {
      const [action = "on", requestedName] = splitArgs(args);
      if (action === "status") {
        const status = await capabilities.probe("jj-workspaces");
        const recent = (await transitions.list()).filter((record) => record.workspace.backend === "jj");
        ctx.ui.notify(
          `JJ workspaces: ${status.toolsExposed ? "on" : status.available ? "off" : "unavailable"}; ${recent.length} transition record(s).`,
          status.available ? "info" : "warning",
        );
        return;
      }
      if (action === "off") {
        capabilities.disable("jj-workspaces", "user");
        ctx.ui.notify("JJ workspace capability disabled.", "info");
        return;
      }
      if (action === "on") {
        assertStandalone(ctx);
        await capabilities.enable("jj-workspaces", { owner: "user", exposure: "model-tools" });
        ctx.ui.notify("JJ workspace capability enabled.", "info");
        return;
      }
      if (action !== "new" && action !== "create-only") {
        ctx.ui.notify("Usage: /cap:jj-workspaces [on|off|status|new [name]|create-only [name]]", "warning");
        return;
      }
      assertStandalone(ctx);
      await ctx.waitForIdle();
      await capabilities.enable("jj-workspaces", { owner: "user", exposure: "model-tools" });
      const name = workspaceName(requestedName);
      if (action === "create-only") {
        const record = await allocateTransition(jj, transitions, ctx, name);
        ctx.ui.notify(`Created JJ workspace ${record.workspace.path}.`, "info");
        return;
      }
      await relocate(jj, transitions, delegations, capabilities, ctx, name);
    },
  });

  pi.registerCommand("cap:git-worktrees", {
    description: "Enable, inspect, create, or enter standalone Git worktrees",
    handler: async (args, ctx) => {
      const [action = "on", requestedName] = splitArgs(args);
      if (action === "status") {
        const status = await capabilities.probe("git-worktrees");
        const recent = (await transitions.list()).filter((record) => record.workspace.backend === "git");
        ctx.ui.notify(
          `Git worktrees: ${status.toolsExposed ? "on" : status.available ? "off" : "unavailable"}; ${recent.length} transition record(s).`,
          status.available ? "info" : "warning",
        );
        return;
      }
      if (action === "off") {
        capabilities.disable("git-worktrees", "user");
        ctx.ui.notify("Git worktree capability disabled.", "info");
        return;
      }
      if (action === "on") {
        assertStandalone(ctx);
        await capabilities.enable("git-worktrees", { owner: "user", exposure: "model-tools" });
        ctx.ui.notify("Git worktree capability enabled.", "info");
        return;
      }
      if (action !== "new" && action !== "create-only") {
        ctx.ui.notify("Usage: /cap:git-worktrees [on|off|status|new [name]|create-only [name]]", "warning");
        return;
      }
      assertStandalone(ctx);
      await ctx.waitForIdle();
      await capabilities.enable("git-worktrees", { owner: "user", exposure: "model-tools" });
      const name = workspaceName(requestedName);
      if (action === "create-only") {
        const record = await allocateTransition(git, transitions, ctx, name);
        ctx.ui.notify(`Created Git worktree ${record.workspace.path}.`, "info");
        return;
      }
      await relocate(git, transitions, delegations, capabilities, ctx, name);
    },
  });

  pi.registerTool({
    name: "create_jj_workspace",
    label: "Enter JJ Workspace",
    description: "Create a JJ workspace and continue this standalone agent in a forked successor session there.",
    promptSnippet: "Move standalone work into a new isolated JJ workspace",
    promptGuidelines: [
      "Use create_jj_workspace only when the user wants this standalone agent to move into a new JJ workspace.",
      "Do not use create_jj_workspace in parent or child subagent roles.",
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Optional lowercase workspace name" })),
    }),
    async execute(_id, params) {
      const name = workspaceName(params.name);
      pi.sendUserMessage(`/cap:jj-workspaces new ${name}`, { deliverAs: "followUp" });
      return {
        content: [{ type: "text" as const, text: `Queued standalone relocation into JJ workspace ${name}.` }],
        details: { name },
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "create_git_worktree",
    label: "Enter Git Worktree",
    description: "Create a Git worktree and continue this standalone agent in a forked successor session there.",
    promptSnippet: "Move standalone work into a new isolated Git worktree",
    promptGuidelines: [
      "Use create_git_worktree only when the user wants this standalone agent to move into a new Git worktree.",
      "Do not use create_git_worktree in parent or child subagent roles.",
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Optional lowercase worktree name" })),
    }),
    async execute(_id, params) {
      const name = workspaceName(params.name);
      pi.sendUserMessage(`/cap:git-worktrees new ${name}`, { deliverAs: "followUp" });
      return {
        content: [{ type: "text" as const, text: `Queued standalone relocation into Git worktree ${name}.` }],
        details: { name },
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "jj_workspace_status",
    label: "JJ Workspace Status",
    description: "List recorded standalone JJ workspace transitions.",
    parameters: Type.Object({}),
    async execute() {
      const records = (await transitions.list()).filter((record) => record.workspace.backend === "jj");
      const text = records.length === 0
        ? "No standalone JJ workspace transitions."
        : records.map((record) => `${record.id}: ${record.state} ${record.workspace.path}`).join("\n");
      return { content: [{ type: "text" as const, text }], details: records };
    },
  });

  pi.registerTool({
    name: "git_worktree_status",
    label: "Git Worktree Status",
    description: "List recorded standalone Git worktree transitions.",
    parameters: Type.Object({}),
    async execute() {
      const records = (await transitions.list()).filter((record) => record.workspace.backend === "git");
      const text = records.length === 0
        ? "No standalone Git worktree transitions."
        : records.map((record) => `${record.id}: ${record.state} ${record.workspace.path}`).join("\n");
      return { content: [{ type: "text" as const, text }], details: records };
    },
  });
}

async function relocate(
  workspace: WorkspacePort,
  transitions: WorkspaceTransitionStore,
  delegations: DelegationStore,
  capabilities: SessionCapabilityController,
  ctx: ExtensionCommandContext,
  name: string,
): Promise<void> {
  const activeChildren = (await delegations.listChildren(ctx.sessionManager.getSessionId()))
    .filter((record) => !isResolvedDelegation(record));
  if (activeChildren.length > 0) {
    throw new Error("Cannot relocate a session with unresolved child delegations.");
  }
  const sourceSessionFile = ctx.sessionManager.getSessionFile();
  const sourceIsPersisted = Boolean(sourceSessionFile && existsSync(sourceSessionFile));
  const hasConversationContext = ctx.sessionManager.getEntries().some((entry) =>
    entry.type === "message"
    || entry.type === "custom_message"
    || entry.type === "compaction"
    || entry.type === "branch_summary"
  );
  if (!sourceIsPersisted && hasConversationContext) {
    throw new Error("Workspace relocation cannot preserve an unpersisted source session with conversation context.");
  }
  const record = await allocateTransition(workspace, transitions, ctx, name);
  try {
    const sessionDir = sourceSessionFile ? dirname(sourceSessionFile) : ctx.sessionManager.getSessionDir();
    const successor = sourceIsPersisted
      ? SessionManager.forkFrom(sourceSessionFile!, record.workspace.path, sessionDir)
      : await createPersistedSession(record.workspace.path, sessionDir);
    successor.appendCustomEntry(TRANSITION_ENTRY, {
      transitionId: record.id,
      sourceSessionId: record.sourceSessionId,
      sourceSessionFile,
      workspace: record.workspace,
    });
    successor.appendCustomEntry(CAPABILITY_STATE_ENTRY, {
      enabled: capabilities.snapshot().capabilities
        .filter((capability) => capability.leases.some((lease) => lease.owner === "user"))
        .map((capability) => capability.id),
    });
    const successorSessionFile = successor.getSessionFile();
    if (!successorSessionFile) throw new Error("Successor session is not persistent.");
    const result = await ctx.switchSession(successorSessionFile, {
      withSession: async (next) => {
        next.ui.notify(`Continued in ${record.workspace.path}.`, "info");
      },
    });
    if (result.cancelled) {
      await transitions.update(record.id, (current) => ({
        ...current,
        state: "failed",
        error: "Session switch was cancelled.",
      }));
      return;
    }
    await transitions.update(record.id, (current) => ({
      ...current,
      state: "switched",
      successorSessionId: successor.getSessionId(),
      successorSessionFile,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await transitions.update(record.id, (current) => ({ ...current, state: "failed", error: message }));
    throw error;
  }
}

async function createPersistedSession(cwd: string, sessionDir: string): Promise<SessionManager> {
  const pending = SessionManager.create(cwd, sessionDir);
  const sessionFile = pending.getSessionFile();
  if (!sessionFile) throw new Error("Successor session is not persistent.");
  await writeFile(sessionFile, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
  return SessionManager.open(sessionFile, sessionDir, cwd);
}

async function allocateTransition(
  workspace: WorkspacePort,
  transitions: WorkspaceTransitionStore,
  ctx: ExtensionCommandContext,
  name: string,
): Promise<WorkspaceTransitionRecord> {
  const sourceSessionFile = ctx.sessionManager.getSessionFile();
  const attachment = await workspace.create({ cwd: ctx.cwd, name, purpose: "relocation" });
  const now = new Date().toISOString();
  const record: WorkspaceTransitionRecord = {
    version: 1,
    id: `transition-${randomUUID().slice(0, 12)}`,
    state: "allocated",
    sourceSessionId: ctx.sessionManager.getSessionId(),
    sourceSessionFile,
    sourceCwd: ctx.cwd,
    workspace: attachment,
    createdAt: now,
    updatedAt: now,
  };
  await transitions.create(record);
  return record;
}

function assertStandalone(ctx: ExtensionCommandContext): void {
  const mode = reconstructSubagentState(ctx.sessionManager.getEntries()).mode;
  if (mode !== "standalone") throw new Error(`Workspace relocation requires standalone mode; current mode is ${mode}.`);
}

function splitArgs(input: string): [string, string | undefined] {
  const [action, name] = input.trim().split(/\s+/, 2);
  return [(action || "on").toLowerCase(), name];
}

function workspaceName(requested?: string): string {
  if (requested) {
    const normalized = requested.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(normalized)) {
      throw new Error("Workspace name must contain lowercase letters, numbers, and hyphens only.");
    }
    return normalized;
  }
  return `workspace-${randomUUID().slice(0, 8)}`;
}
