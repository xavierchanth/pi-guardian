import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_MODEL_PREFERENCES,
  MODEL_PREFERENCE_IDS,
  PARENT_TOOL_NAMES,
  activeToolsForRole,
  composePiTaiInstructions,
  parseSubagentsCommand,
  type SubagentRole,
} from "./domain.ts";
import { loadPackagedInstructions, roleInstructions, type InstructionLoader } from "./instructions.ts";
import { JjWorkspaceService } from "./jj.ts";
import { PiChildProcessLauncher } from "./launcher.ts";
import { SubagentOrchestrator } from "./orchestrator.ts";
import {
  FileDelegationStore,
  isResolvedDelegation,
  type DelegationRecord,
  type DelegationStore,
} from "./store.ts";

const ROLE_ENTRY = "pi-tai-subagent-role";
const CHILD_ENV = "PI_TAI_DELEGATION_ID";
const STORE_ENV = "PI_TAI_DELEGATION_STORE";

export interface SubagentDependencies {
  store?: DelegationStore;
  orchestrator?: SubagentOrchestrator;
  loadInstructions?: InstructionLoader;
  childDelegationId?: string;
}

export function registerSubagents(
  pi: ExtensionAPI,
  dependencies: SubagentDependencies = {},
): void {
  const storeRoot = process.env[STORE_ENV]
    || join(getAgentDir(), "pi-tai", "subagents", "delegations");
  const store = dependencies.store ?? new FileDelegationStore(storeRoot);
  const orchestrator = dependencies.orchestrator ?? new SubagentOrchestrator({
    store,
    jj: new JjWorkspaceService(),
    launcher: new PiChildProcessLauncher(store),
  });
  const loadInstructions = dependencies.loadInstructions ?? loadPackagedInstructions;
  const processChildDelegationId = dependencies.childDelegationId ?? process.env[CHILD_ENV];
  let childDelegationId = processChildDelegationId;
  let role: SubagentRole = "standalone";
  let childDelegation: DelegationRecord | undefined;
  let spawnSeenThisTurn = false;
  const parentTools = new Set<string>(PARENT_TOOL_NAMES);

  const applyRoleTools = () => {
    pi.setActiveTools(activeToolsForRole(pi.getActiveTools(), role));
  };

  pi.on("session_start", async (event, ctx) => {
    const persisted = reconstructRoleState(ctx.sessionManager.getEntries());
    role = processChildDelegationId
      ? "child"
      : event.reason === "new" || event.reason === "fork"
        ? "standalone"
        : persisted.role;
    childDelegationId = role === "child"
      ? processChildDelegationId ?? persisted.delegationId
      : undefined;
    if (!processChildDelegationId && (event.reason === "new" || event.reason === "fork")) {
      pi.appendEntry(ROLE_ENTRY, { role: "standalone" });
    }
    if (role === "child") {
      if (!childDelegationId) throw new Error("Child session is missing its durable delegation identity.");
      childDelegation = await orchestrator.child(childDelegationId);
      if (!hasRoleEntry(ctx.sessionManager.getEntries(), "child")) {
        pi.appendEntry(ROLE_ENTRY, { role: "child", delegationId: childDelegationId });
      }
      await orchestrator.attachChildSession(childDelegationId, {
        id: ctx.sessionManager.getSessionId(),
        file: ctx.sessionManager.getSessionFile(),
      });
    }
    applyRoleTools();
  });

  pi.on("before_agent_start", async (event) => {
    const instructions = loadInstructions();
    if (role === "child" && childDelegationId) {
      childDelegation = await orchestrator.child(childDelegationId);
    }
    return {
      systemPrompt: composePiTaiInstructions({
        basePrompt: event.systemPrompt,
        role,
        systemInstructions: instructions.system,
        roleInstructions: roleInstructions(instructions, role),
        ...(role === "parent" ? { modelPreferences: DEFAULT_MODEL_PREFERENCES } : {}),
        ...(childDelegation ? {
          delegation: {
            id: childDelegation.id,
            parentSessionId: childDelegation.parentSessionId,
            workspace: childDelegation.childWorkspace,
            baseChangeId: childDelegation.baseChangeId,
            childRootChangeId: childDelegation.childRootChangeId,
          },
        } : {}),
      }),
    };
  });

  pi.on("turn_start", () => {
    spawnSeenThisTurn = false;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (role !== "parent") return;
    if (event.toolName === "spawn_child") {
      spawnSeenThisTurn = true;
      return;
    }
    if (event.toolName === "bash" && requestsJjWorkspaceCreation(event.input)) {
      return {
        block: true,
        reason: "Parent sessions must use spawn_child to create a JJ workspace and delegate its task; do not run jj workspace add directly.",
      };
    }
    if (parentTools.has(event.toolName)) return;
    if (spawnSeenThisTurn || entrySpawnsChild(ctx.sessionManager.getLeafEntry?.())) {
      return {
        block: true,
        reason: "Parent work cannot run in the same turn as spawn_child. Delegate the complete task, then wait_for_children.",
      };
    }
    const activeChildren = (await orchestrator.children(ctx.sessionManager.getSessionId()))
      .filter((record) => !isResolvedDelegation(record));
    if (activeChildren.length > 0) {
      return {
        block: true,
        reason: `Parent work is paused while ${activeChildren.length} child delegation(s) are active. Use message_child, child_status, wait_for_children, or abandon_child.`,
      };
    }
  });

  pi.on("session_shutdown", async (event) => {
    if (event.reason === "quit" && role === "child" && childDelegationId) {
      await orchestrator.cleanupChildControl(childDelegationId);
    }
  });

  pi.registerCommand("sub-agents", {
    description: "Enable, inspect, or disable direct-child subagents",
    handler: async (args, ctx) => {
      const command = parseSubagentsCommand(args);
      if (!command) {
        ctx.ui.notify("Usage: /sub-agents [on|off|status]", "warning");
        return;
      }
      if (command === "status") {
        const children = await orchestrator.children(ctx.sessionManager.getSessionId());
        const unresolved = children.filter((record) => !isResolvedDelegation(record)).length;
        ctx.ui.notify(`Subagents: ${role}; ${children.length} children, ${unresolved} unresolved.`, "info");
        return;
      }
      if (role === "child") {
        ctx.ui.notify("Child sessions cannot change subagent role.", "error");
        return;
      }
      if (command === "on") {
        if (role !== "parent") {
          role = "parent";
          pi.appendEntry(ROLE_ENTRY, { role });
          applyRoleTools();
        }
        ctx.ui.notify("Subagents enabled for this parent session.", "info");
        return;
      }
      const children = await orchestrator.children(ctx.sessionManager.getSessionId());
      const unresolved = children.filter((record) => !isResolvedDelegation(record));
      if (unresolved.length > 0) {
        ctx.ui.notify(`Cannot disable subagents with ${unresolved.length} unresolved children.`, "error");
        return;
      }
      role = "standalone";
      pi.appendEntry(ROLE_ENTRY, { role });
      applyRoleTools();
      ctx.ui.notify("Subagents disabled for this session.", "info");
    },
  });

  pi.registerTool({
    name: "spawn_child",
    label: "Spawn Child",
    description: "Create a linked JJ workspace and persistent direct-child Pi session that exclusively performs the delegated task. Parent sessions only.",
    promptSnippet: "Create a JJ workspace and delegate all work in it to a direct child",
    promptGuidelines: [
      "Use spawn_child whenever the user asks a parent session to create a JJ workspace for work; include the complete task and acceptance criteria so the child performs all workspace work.",
      "Never run jj workspace add directly in a parent session; spawn_child owns workspace creation.",
      "After spawning requested children, call wait_for_children immediately instead of reading, editing, testing, or otherwise doing their work in the parent thread.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Complete bounded task and acceptance criteria for the child" }),
      modelPreferenceId: StringEnum(MODEL_PREFERENCE_IDS, {
        description: "Semantic model preference selected from the parent prompt",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireRole(role, "parent");
      const record = await orchestrator.spawnChild({
        task: params.task,
        modelPreferenceId: params.modelPreferenceId,
        parentCwd: ctx.cwd,
        parentSessionId: ctx.sessionManager.getSessionId(),
        parentSessionFile: ctx.sessionManager.getSessionFile(),
      });
      return result(`Spawned child ${record.id} (${record.modelPreferenceId}) in ${record.childWorkspacePath}. Parent work is paused; wait for the child or message it.`, record);
    },
  });

  pi.registerTool({
    name: "message_child",
    label: "Message Child",
    description: "Send updated instructions to a running direct child through its persistent control channel.",
    promptSnippet: "Steer a running child or queue a follow-up instruction",
    promptGuidelines: [
      "Use message_child to correct or extend a running child's delegated instructions without doing the work in the parent thread.",
    ],
    parameters: Type.Object({
      delegationId: Type.String(),
      message: Type.String({ minLength: 1, maxLength: 16_000 }),
      delivery: Type.Optional(StringEnum(["steer", "followUp"] as const, {
        description: "steer applies after the current child turn; followUp waits until its current run settles",
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireRole(role, "parent");
      const existing = await orchestrator.child(params.delegationId);
      assertParent(existing, ctx.sessionManager.getSessionId());
      const record = await orchestrator.message(
        params.delegationId,
        params.message,
        params.delivery ?? "steer",
      );
      return result(`Sent ${params.delivery ?? "steer"} message to child ${record.id}.`, record);
    },
  });

  pi.registerTool({
    name: "wait_for_children",
    label: "Wait for Children",
    description: "Wait without parent LLM calls until every currently active direct child reports a terminal outcome.",
    promptSnippet: "Wait for all currently active direct children without parent model churn",
    promptGuidelines: ["Use wait_for_children after delegation when parent work would overlap or speculate about child results."],
    parameters: Type.Object({}),
    async execute(_id, _params, signal, onUpdate, ctx) {
      requireRole(role, "parent");
      const records = await orchestrator.wait(ctx.sessionManager.getSessionId(), {
        signal,
        onProgress(current) {
          const resolved = current.filter(isResolvedDelegation).length;
          onUpdate?.(result(`Waiting for children: ${resolved}/${current.length} resolved.`, current));
        },
      });
      return result(formatReports(records), records);
    },
  });

  pi.registerTool({
    name: "child_status",
    label: "Child Status",
    description: "Inspect one direct child or list every child belonging to this parent session.",
    parameters: Type.Object({
      delegationId: Type.Optional(Type.String({ description: "Delegation ID; omit to list all children" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireRole(role, "parent");
      const records = params.delegationId
        ? [await orchestrator.child(params.delegationId)]
        : await orchestrator.children(ctx.sessionManager.getSessionId());
      for (const record of records) assertParent(record, ctx.sessionManager.getSessionId());
      return result(formatReports(records), records);
    },
  });

  pi.registerTool({
    name: "integrate_child",
    label: "Integrate Child",
    description: "Integrate a completed child's recorded JJ subtree with rebase -s before parent @, or finalize cleanup after parent verification.",
    promptSnippet: "Integrate a completed child JJ subtree or finalize its verified workspace cleanup",
    promptGuidelines: [
      "Use integrate_child with finalize false to preserve and insert the child root plus all descendants before parent @.",
      "Run parent validation before calling integrate_child with finalize true.",
    ],
    parameters: Type.Object({
      delegationId: Type.String(),
      finalize: Type.Optional(Type.Boolean({ description: "After parent verification, forget and remove the child workspace" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireRole(role, "parent");
      const existing = await orchestrator.child(params.delegationId);
      assertParent(existing, ctx.sessionManager.getSessionId());
      const record = await orchestrator.integrate(params.delegationId, params.finalize ?? false);
      return result(
        record.state === "conflicted"
          ? `Child ${record.id} integrated with conflicts: ${(record.conflictFiles ?? []).join(", ")}`
          : `Child ${record.id}: ${record.state}.`,
        record,
      );
    },
  });

  pi.registerTool({
    name: "abandon_child",
    label: "Abandon Child",
    description: "Explicitly stop a child and forget/remove its workspace while retaining its JJ changes by change ID.",
    parameters: Type.Object({ delegationId: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireRole(role, "parent");
      const existing = await orchestrator.child(params.delegationId);
      assertParent(existing, ctx.sessionManager.getSessionId());
      const record = await orchestrator.abandon(params.delegationId);
      return result(`Abandoned child ${record.id}; its JJ changes were not automatically abandoned.`, record);
    },
  });

  pi.registerTool({
    name: "report_to_parent",
    label: "Report to Parent",
    description: "Required terminal action for a child. Persist one outcome report, wake the parent waiter, and end the child run.",
    promptSnippet: "Report the delegated child outcome to its parent and terminate the child run",
    promptGuidelines: ["Child sessions must call report_to_parent exactly once after completing validation or encountering a blocker."],
    parameters: Type.Object({
      outcome: StringEnum(["completed", "blocked", "failed", "cancelled"] as const),
      summary: Type.String(),
      validation: Type.Optional(Type.Array(Type.String())),
      changedFiles: Type.Optional(Type.Array(Type.String())),
      concerns: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      requireRole(role, "child");
      if (!childDelegationId) throw new Error("Child delegation identity is unavailable.");
      const record = await orchestrator.report(childDelegationId, {
        outcome: params.outcome,
        summary: params.summary,
        ...(params.validation ? { validation: params.validation } : {}),
        ...(params.changedFiles ? { changedFiles: params.changedFiles } : {}),
        ...(params.concerns ? { concerns: params.concerns } : {}),
      });
      ctx.shutdown();
      return {
        ...result(`Reported ${record.state} to parent for ${record.id}.`, record),
        terminate: true,
      };
    },
  });
}

function reconstructRoleState(entries: readonly SessionEntry[]): {
  role: SubagentRole;
  delegationId?: string;
} {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== ROLE_ENTRY) continue;
    const data = entry.data as { role?: unknown; delegationId?: unknown } | undefined;
    if (data?.role === "standalone" || data?.role === "parent" || data?.role === "child") {
      return {
        role: data.role,
        ...(typeof data.delegationId === "string" ? { delegationId: data.delegationId } : {}),
      };
    }
  }
  return { role: "standalone" };
}

function hasRoleEntry(entries: readonly SessionEntry[], expected: SubagentRole): boolean {
  return reconstructRoleState(entries).role === expected;
}

function requireRole(actual: SubagentRole, expected: SubagentRole): void {
  if (actual !== expected) throw new Error(`Tool requires subagent role ${expected}; current role is ${actual}.`);
}

function assertParent(record: DelegationRecord, sessionId: string): void {
  if (record.parentSessionId !== sessionId) throw new Error(`Delegation ${record.id} does not belong to this parent session.`);
}

function requestsJjWorkspaceCreation(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" && /(?:^|[;&|()\s])jj\b[^\n;&|]*\bworkspace\s+add(?:\s|$)/i.test(command);
}

function entrySpawnsChild(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const candidate = entry as {
    type?: unknown;
    message?: { role?: unknown; content?: unknown };
  };
  return candidate.type === "message"
    && candidate.message?.role === "assistant"
    && Array.isArray(candidate.message.content)
    && candidate.message.content.some((part) => Boolean(
      part
      && typeof part === "object"
      && !Array.isArray(part)
      && (part as { type?: unknown }).type === "toolCall"
      && (part as { name?: unknown }).name === "spawn_child",
    ));
}

function formatReports(records: readonly DelegationRecord[]): string {
  if (records.length === 0) return "No matching child delegations.";
  return records.map((record) => {
    const summary = record.report?.summary ? ` — ${record.report.summary}` : "";
    return `${record.id}: ${record.state}${summary}`;
  }).join("\n");
}

function result(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}
