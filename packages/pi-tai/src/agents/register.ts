import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SessionPolicyReader } from "../config/register.ts";
import {
  FileWorkspaceRegistry,
  JjCli,
  WorkspaceManager,
  type MergeStrategy,
  type WorkspaceRecord,
} from "../isolation/index.ts";
import { JjProcessExecutor } from "../jj/executor.ts";
import { composePiTaiInstructions } from "../subagents/domain.ts";
import { loadPackagedInstructions, type InstructionLoader } from "../subagents/instructions.ts";
import { BackendRegistry, type SubagentBackend } from "./backend.ts";
import { ClaudeBackend } from "./backends/claude.ts";
import { CodexBackend } from "./backends/codex.ts";
import { PiBackend } from "./backends/pi.ts";
import { registerSubagentDashboard } from "./dashboard-view.ts";
import { contextUtilisation, type BackendName, type SubagentSnapshot } from "./domain.ts";
import { IsolatedSubagents } from "./isolated.ts";
import { SubagentManager } from "./manager.ts";
import { MODEL_ALIAS_NAMES, resolveModel } from "./models.ts";
import {
  CANCEL_DESCRIPTION,
  CHECK_DESCRIPTION,
  DELEGATION_GUIDELINES,
  DISCARD_DESCRIPTION,
  LIST_DESCRIPTION,
  MERGE_DESCRIPTION,
  SEND_DESCRIPTION,
  SPAWN_DESCRIPTION,
  WAIT_DESCRIPTION,
  WORKSPACE_GUIDELINES,
  WORKSPACE_STATUS_DESCRIPTION,
  composeChildCharter,
  composeChildPrompt,
} from "./prompt.ts";

export interface AgentsDependencies {
  readonly config: SessionPolicyReader;
  readonly agentDir?: string;
  /**
   * Backends the model may choose. `pi` is always present; the others default
   * to enabled and report themselves unavailable when their SDK or binary is
   * missing, which is a clearer failure than a harness silently absent from the
   * tool schema.
   */
  readonly backends?: readonly BackendName[];
  /**
   * Harness used when a spawn names none. Set this to run implementation on a
   * different harness than the one you are talking to.
   */
  readonly defaultBackend?: BackendName;
  /** Test seams. */
  readonly workspaces?: WorkspaceManager;
  readonly extraBackends?: readonly SubagentBackend[];
  readonly loadInstructions?: InstructionLoader;
}

interface Runtime {
  readonly workspaces: WorkspaceManager;
  readonly agents: SubagentManager;
  readonly isolated: IsolatedSubagents;
}

/**
 * Tools a pi child gets. Claude and Codex run their own default toolsets; there
 * is no portable allowlist, and there does not need to be.
 */
const CHILD_TOOLS = ["read", "write", "edit", "grep", "find", "ls", "bash", "web_search", "web_fetch"] as const;

const MAX_RESULT_BYTES = 16 * 1024;

export function registerAgents(pi: ExtensionAPI, dependencies: AgentsDependencies): void {
  const agentDir = dependencies.agentDir ?? getAgentDir();
  const enabled: BackendName[] = ["pi", ...(dependencies.backends ?? ["claude", "codex"]).filter((name) => name !== "pi")];
  const loadInstructions = dependencies.loadInstructions ?? loadPackagedInstructions;
  let runtime: Promise<Runtime> | undefined;
  /** Settled runtime, for callers such as the dashboard that cannot await one. */
  let built: Runtime | undefined;

  /**
   * The runtime needs a model registry and a cwd, which only exist once a
   * session is up. Building it on first use keeps the extension loadable in
   * contexts that never delegate.
   */
  const requireRuntime = (ctx: ExtensionContext): Promise<Runtime> => {
    runtime ??= build(ctx);
    return runtime;
  };

  async function build(ctx: ExtensionContext): Promise<Runtime> {
    const stateRoot = join(agentDir, "pi-tai", "agents");
    const workspaces = dependencies.workspaces ?? new WorkspaceManager({
      jj: new JjCli(new JjProcessExecutor()),
      registry: new FileWorkspaceRegistry(stateRoot),
      sourcePath: ctx.cwd,
      workspaceRoot: join(stateRoot, "workspaces"),
    });
    const backends: SubagentBackend[] = [
      new PiBackend({
        config: dependencies.config,
        modelRegistry: ctx.modelRegistry,
        stateRoot: join(stateRoot, "sessions"),
        agentDir,
      }),
      ...(enabled.includes("claude") ? [new ClaudeBackend()] : []),
      ...(enabled.includes("codex") ? [new CodexBackend()] : []),
      ...(dependencies.extraBackends ?? []),
    ];

    let isolated!: IsolatedSubagents;
    const agents = new SubagentManager({
      registry: new BackendRegistry(backends),
      onSettled: async (snapshot) => {
        await isolated.reclaimIfEmpty(snapshot);
      },
    });
    isolated = new IsolatedSubagents({ agents, workspaces, sourcePath: ctx.cwd });
    built = { workspaces, agents, isolated };
    return built;
  }

  registerSubagentDashboard(pi, () => built?.agents);

  // ---- spawning -------------------------------------------------------------

  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: SPAWN_DESCRIPTION,
    promptSnippet: "Start an autonomous background subagent on a self-contained task",
    promptGuidelines: [...DELEGATION_GUIDELINES],
    parameters: Type.Object({
      objective: Type.String({ description: "What the subagent must accomplish, stated so it stands alone" }),
      isolation: Type.Union([Type.Literal("workspace"), Type.Literal("shared")], {
        description: "workspace: a private checkout the subagent may change. shared: your working copy, read-only.",
      }),
      background: Type.Optional(Type.String({ description: "Context the subagent needs but cannot discover on its own" })),
      acceptanceCriteria: Type.Optional(Type.Array(Type.String(), {
        description: "Conditions that must hold for the task to be complete",
        minItems: 1,
        maxItems: 32,
      })),
      constraints: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
      backend: Type.Optional(Type.Union(enabled.map((name) => Type.Literal(name)), {
        description: "Harness to run on. Defaults to pi; choose another only when the task genuinely suits it.",
      })),
      model: Type.Optional(Type.String({
        description: `Model alias (${MODEL_ALIAS_NAMES.join(", ")}) or an explicit provider/model id. An alias selects its harness; incompatible model/backend pairs are rejected.`,
      })),
      effort: Type.Optional(Type.Union(
        ["low", "medium", "high", "xhigh", "max"].map((level) => Type.Literal(level)),
        {
          description: "Reasoning effort. Omit this: each model has a default chosen for its purpose. "
            + "Set it only when the user asks for a different reasoning level.",
        },
      )),
      title: Type.Optional(Type.String({ description: "Short label for progress display" })),
      continue: Type.Optional(Type.String({
        description: "Id of a finished subagent whose workspace this one should pick up, instead of starting a fresh checkout.",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { isolated } = await requireRuntime(ctx);
      const resolved = resolveModel({
        ...(params.model ? { model: params.model } : {}),
        ...(params.backend ? { backend: params.backend } : { backend: dependencies.defaultBackend ?? "pi" }),
        ...(params.effort ? { effort: params.effort } : {}),
      });
      if (!resolved.ok) return failure(resolved.reason);
      const { backend, provider, model, effort } = resolved.choice;
      if (!enabled.includes(backend)) {
        return failure(`Backend "${backend}" is not enabled here. Enabled: ${enabled.join(", ")}.`);
      }
      const isolatedRun = params.isolation === "workspace";
      const title = params.title ?? firstLine(params.objective);
      let snapshot;
      try {
        snapshot = await isolated.spawn({
        backend,
        isolation: params.isolation,
        title,
        tools: [...CHILD_TOOLS],
        provider,
        model,
        effort,
        prompt: composeChildPrompt({
          objective: params.objective,
          ...(params.background ? { background: params.background } : {}),
          ...(params.acceptanceCriteria ? { acceptanceCriteria: params.acceptanceCriteria } : {}),
        }),
        ...(params.continue ? { continueFrom: params.continue } : {}),
        systemPrompt: (cwd) => composeChildCharter({
          resuming: Boolean(params.continue),
          objective: params.objective,
          cwd,
          isolated: isolatedRun,
          ...(params.acceptanceCriteria ? { acceptanceCriteria: params.acceptanceCriteria } : {}),
          ...(params.constraints ? { constraints: params.constraints } : {}),
        }),
        });
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
      return success(
        `Started ${snapshot.id} (${snapshot.backend}, ${provider}/${model}, effort ${effort})`
        + `${isolatedRun ? " in its own workspace" : " in the shared working copy"}.`
        + " Keep working; its result will arrive automatically.",
        { id: snapshot.id, backend: snapshot.backend, model: `${provider}/${model}`, effort, workspaceId: isolated.workspaceFor(snapshot.id) },
      );
    },
  });

  // ---- observing ------------------------------------------------------------

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait For Subagents",
    description: WAIT_DESCRIPTION,
    promptSnippet: "Block until any named subagent finishes and return every result ready then",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), { description: "Subagent ids to wait for", minItems: 1, maxItems: 16 }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { agents } = await requireRuntime(ctx);
      const result = await agents.wait(params.ids, signal);
      const ready = result.settled.map(renderResult).join("\n\n---\n\n");
      const pending = result.pending.map((snapshot) => snapshot.id);
      const remaining = pending.length ? `\n\nStill running: ${pending.join(", ")}.` : "";
      return success(ready + remaining, {
        settled: result.settled.map((snapshot) => snapshot.id), pending, reason: result.reason,
      });
    },
  });

  pi.registerTool({
    name: "subagent_check",
    label: "Check Subagent",
    description: CHECK_DESCRIPTION,
    promptSnippet: "Peek at a running subagent without blocking",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { agents } = await requireRuntime(ctx);
      const snapshot = agents.get(params.id);
      if (!snapshot) return failure(`Unknown subagent ${params.id}.`);
      return success(
        `${renderLine(snapshot)}\nturns: ${snapshot.turns}\n\n${truncate(snapshot.latestText, 2048) || "(no output yet)"}`,
        { id: snapshot.id, status: snapshot.status },
      );
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: LIST_DESCRIPTION,
    promptSnippet: "List subagents and their status",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const { agents } = await requireRuntime(ctx);
      const all = agents.list();
      if (!all.length) return success("No subagents have been started in this session.", { count: 0 });
      return success(all.map(renderLine).join("\n"), { count: all.length });
    },
  });

  // ---- steering -------------------------------------------------------------

  pi.registerTool({
    name: "subagent_send",
    label: "Send To Subagent",
    description: SEND_DESCRIPTION,
    promptSnippet: "Steer a running subagent",
    parameters: Type.Object({
      id: Type.String(),
      message: Type.String({ description: "Guidance for the subagent, stated so it stands alone" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { agents } = await requireRuntime(ctx);
      try {
        await agents.send(params.id, params.message);
      } catch (error) {
        return failure(describe(error));
      }
      return success(`Sent guidance to ${params.id}.`, { id: params.id });
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Subagents",
    description: CANCEL_DESCRIPTION,
    promptSnippet: "Stop running subagents, keeping their workspaces",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), { minItems: 1, maxItems: 16 }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { agents } = await requireRuntime(ctx);
      try {
        const cancelled = await agents.cancel(params.ids);
        return success(
          `Stopped ${cancelled.length} subagent(s). Their workspaces are kept; merge or discard them when you have decided.`,
          { ids: cancelled.map((snapshot) => snapshot.id) },
        );
      } catch (error) {
        return failure(describe(error));
      }
    },
  });

  // ---- reconciliation -------------------------------------------------------

  pi.registerTool({
    name: "workspace_merge",
    label: "Merge Subagent Work",
    description: MERGE_DESCRIPTION,
    promptSnippet: "Fold a finished subagent's changes into the working copy",
    promptGuidelines: [...WORKSPACE_GUIDELINES],
    parameters: Type.Object({
      id: Type.String({ description: "Subagent id whose workspace should be merged" }),
      strategy: Type.Optional(Type.Union(
        [Type.Literal("auto"), Type.Literal("linear"), Type.Literal("merge-under")],
        { description: "Defaults to auto, which is almost always right." },
      )),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { isolated } = await requireRuntime(ctx);
      let result;
      try {
        result = await isolated.merge(params.id, (params.strategy ?? "auto") as MergeStrategy);
      } catch (error) {
        return failure(describe(error));
      }
      if (result.kind === "blocked") return failure(result.reason);
      if (result.kind === "no_changes") {
        return success(`${params.id} produced no changes; its workspace has been removed.`, { merged: false });
      }
      const { summary } = result;
      const conflicts = summary.conflictPaths.length
        ? `\nConflicts to resolve in the working copy: ${summary.conflictPaths.join(", ")}`
        : "";
      return success(
        `Merged ${summary.changeIds.length} change(s) from ${params.id} using the ${summary.strategy} strategy.${conflicts}`,
        { merged: true, strategy: summary.strategy, changeIds: summary.changeIds, conflictPaths: summary.conflictPaths },
      );
    },
  });

  pi.registerTool({
    name: "workspace_discard",
    label: "Discard Subagent Work",
    description: DISCARD_DESCRIPTION,
    promptSnippet: "Permanently throw away a subagent's workspace",
    parameters: Type.Object({ id: Type.String({ description: "Subagent id whose workspace should be discarded" }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { isolated } = await requireRuntime(ctx);
      try {
        const { discardedChangeIds } = await isolated.discard(params.id);
        return success(
          `Discarded ${params.id}'s workspace and ${discardedChangeIds.length} change(s).`,
          { discardedChangeIds },
        );
      } catch (error) {
        return failure(describe(error));
      }
    },
  });

  pi.registerTool({
    name: "workspace_status",
    label: "Workspace Status",
    description: WORKSPACE_STATUS_DESCRIPTION,
    promptSnippet: "List managed workspaces and what they hold",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const { workspaces } = await requireRuntime(ctx);
      const records = await workspaces.list();
      if (!records.length) return success("No managed workspaces.", { count: 0 });
      const lines = await Promise.all(records.map(async (record) => {
        const pending = await workspaces.pendingChanges(record.id).catch(() => undefined);
        return renderWorkspace(record, pending?.length);
      }));
      return success(lines.join("\n"), { count: records.length });
    },
  });

  // ---- lifecycle ------------------------------------------------------------

  /**
   * Injects pi-tai's own instructions into this
   * session. Children get their instructions through their charter instead,
   * which is why this only ever composes the root case.
   */
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: composePiTaiInstructions({
      basePrompt: event.systemPrompt,
      mode: "root",
      systemInstructions: loadInstructions().system,
    }),
  }));

  pi.on("session_start", async (_event, ctx) => {
    const { workspaces, isolated } = await requireRuntime(ctx);
    // Reclaim what a crashed session left behind before the model can trip over it.
    const swept = await workspaces.sweep(isolated.activeOwners()).catch(() => []);
    const attention = swept.filter((entry) => entry.disposition === "needs_attention");
    if (attention.length && typeof pi.sendMessage === "function") {
      pi.sendMessage({
        customType: "pi-tai-workspace-sweep",
        content: `${attention.length} managed workspace(s) from an earlier session still hold unmerged work: `
          + `${attention.map((entry) => `${entry.name} (${entry.reason})`).join("; ")}. `
          + "Use workspace_status to inspect them.",
        display: true,
        details: { swept },
      }, { deliverAs: "nextTurn", triggerTurn: false });
    }
  });

  /**
   * Deferred results are flushed when the parent goes idle. This is what lets
   * the orchestrator spawn and keep working instead of polling.
   */
  pi.on("agent_settled", async () => {
    // Drain unconditionally rather than tracking a "something settled" flag: the
    // settle hook is async, so a flag can still be unset when the parent goes
    // idle, which would strand a finished subagent's result until the next turn.
    if (!runtime) return;
    const { agents } = await runtime;
    const results = agents.delivery.drain();
    if (!results.length || typeof pi.sendMessage !== "function") return;
    for (const result of results) {
      const snapshot = agents.get(result.id);
      pi.sendMessage({
        customType: "pi-tai-subagent-result",
        content: snapshot ? renderResult(snapshot) : `Subagent ${result.id} finished:\n${result.text}`,
        display: true,
        details: { id: result.id },
      }, { deliverAs: "followUp", triggerTurn: true });
    }
  });

  pi.on("session_shutdown", async () => {
    if (!runtime) return;
    const { agents } = await runtime;
    await agents.shutdown().catch(() => {});
  });
}

function renderLine(snapshot: SubagentSnapshot): string {
  const context = contextUtilisation(snapshot);
  return `${snapshot.id}  ${snapshot.status.padEnd(7)} ${snapshot.backend.padEnd(6)} `
    + `${context === undefined ? "" : `ctx ${context}%  `}${snapshot.title}`;
}

function renderWorkspace(record: WorkspaceRecord, pending: number | undefined): string {
  const holding = pending === undefined ? "unreadable" : pending === 0 ? "empty" : `${pending} change(s)`;
  return `${record.name}  ${record.phase}  ${holding}${record.owner ? `  owner ${record.owner}` : ""}`;
}

function renderResult(snapshot: SubagentSnapshot): string {
  const header = `Subagent ${snapshot.id} (${snapshot.title}) ${snapshot.status === "done" ? "finished" : "failed"}.`;
  const body = snapshot.status === "done" ? snapshot.finalText : snapshot.errorText ?? "No output.";
  return `${header}\n\n${truncate(body, MAX_RESULT_BYTES)}`;
}

function truncate(value: string, limit: number): string {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  return `${Buffer.from(value, "utf8").subarray(0, limit).toString("utf8")}\n… (truncated)`;
}

function firstLine(value: string): string {
  const line = value.trim().split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function success(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function failure(text: string) {
  return { content: [{ type: "text" as const, text }], details: { error: text }, isError: true };
}

export { composeChildCharter };
