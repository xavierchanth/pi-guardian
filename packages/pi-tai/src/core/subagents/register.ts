import { isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { SessionPolicyReader } from "../../core/config/register.ts";
import {
  JjCli,
  SQLiteWorkspaceManager,
  type WorkspaceManagerPort,
  type WorkspaceRecord,
} from "../isolation/index.ts";
import { SqliteWorkspaceCustody } from "../isolation/sqlite-custody.ts";
import { SQLiteCustodyCoordinator } from "../isolation/sqlite-custody-coordinator.ts";
import { JjProcessExecutor } from "../jj/executor.ts";
import { migrateWorkspaceRegistry } from "../storage/custody-migration.ts";
import { ensureStoragePaths, resolveStoragePaths, type StoragePaths } from "../storage/paths.ts";
import { openDurableDatabase } from "../storage/sqlite.ts";
import { TaskAgentAuthority } from "../tasks/agent-authority.ts";
import { TaskDashboardAdapter } from "../tasks/dashboard.ts";
import { HumanTaskAuthority, issueHumanCapability } from "../tasks/host-authority.ts";
import { connectSubagentActivity } from "./activity.ts";
import { BackendRegistry, type SubagentBackend } from "./backend.ts";
import { ClaudeBackend } from "./backends/claude.ts";
import { CodexBackend } from "./backends/codex.ts";
import { PiBackend } from "./backends/pi.ts";
import {
  CAPABILITIES,
  CAPABILITY_NAMES,
  type CapabilityName,
  capabilityInstructions,
} from "./capabilities.ts";
import { composePiTaiInstructions } from "./charter-domain.ts";
import { type BackendName, contextUtilisation, type SubagentSnapshot } from "./domain.ts";
import { type InstructionLoader, loadPackagedInstructions } from "./instructions.ts";
import { IsolatedSubagents } from "./isolated.ts";
import { PiBranchLifecycleStore } from "./lifecycle.ts";
import { SubagentManager } from "./manager.ts";
import { MODEL_ALIAS_NAMES, MODEL_ALIASES, resolveModel } from "./models.ts";
import {
  CANCEL_DESCRIPTION,
  CHECK_DESCRIPTION,
  composeChildCharter,
  composeChildPrompt,
  DELEGATION_GUIDELINES,
  DISCARD_DESCRIPTION,
  LIST_DESCRIPTION,
  MERGE_DESCRIPTION,
  SEND_DESCRIPTION,
  SPAWN_DESCRIPTION,
  WAIT_DESCRIPTION,
  WAIT_GUIDELINES,
  WORKSPACE_GUIDELINES,
  WORKSPACE_STATUS_DESCRIPTION,
} from "./prompt.ts";
import { containsTemporaryClipboardImage, TEMPORARY_IMAGE_ERROR } from "./temporary-images.ts";

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
  readonly workspaces?: WorkspaceManagerPort;
  readonly extraBackends?: readonly SubagentBackend[];
  readonly loadInstructions?: InstructionLoader;
  /** Composition hook: terminal UI registration stays outside core. */
  readonly registerDashboard?: (
    pi: ExtensionAPI,
    resolveAgents: () => SubagentManager | undefined,
    resolveTasks: () => TaskDashboardAdapter | undefined,
  ) => void;
}

interface Runtime {
  readonly workspaces: WorkspaceManagerPort;
  readonly agents: SubagentManager;
  readonly isolated: IsolatedSubagents;
  /** Owned only by production composition; injected test managers have no DB. */
  readonly database?: DatabaseSync;
  readonly storagePaths?: StoragePaths;
  readonly dashboardTasks?: TaskDashboardAdapter;
}

/**
 * Tools a pi child gets. Claude and Codex run their own default toolsets; there
 * is no portable allowlist, and there does not need to be.
 */
const CHILD_TOOLS = ["read", "write", "edit", "grep", "find", "ls", "bash"] as const;

const MAX_RESULT_BYTES = 16 * 1024;

export function registerAgents(pi: ExtensionAPI, dependencies: AgentsDependencies): void {
  const agentDir = dependencies.agentDir ?? getAgentDir();
  const enabled: BackendName[] = [
    "pi",
    ...(dependencies.backends ?? ["claude", "codex"]).filter((name) => name !== "pi"),
  ];
  const loadInstructions = dependencies.loadInstructions ?? loadPackagedInstructions;
  let runtime: Promise<Runtime> | undefined;
  /** Settled runtime, for callers such as the dashboard that cannot await one. */
  let built: Runtime | undefined;
  const activeWaitInterruptions = new Set<AbortController>();
  // Suppress repeated reassessments until foreground input starts a new exchange.
  let reassessmentSent = false;

  pi.on("input", (event) => {
    // Extension-generated prompts are internal plumbing, not foreground users.
    if (event.source !== "extension") {
      reassessmentSent = false;
      for (const controller of [...activeWaitInterruptions]) controller.abort();
    }
    return { action: "continue" };
  });

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
    let database: DatabaseSync | undefined;
    let workspaces = dependencies.workspaces;
    if (!workspaces) {
      const paths = resolveStoragePaths();
      ensureStoragePaths(paths);
      database = openDurableDatabase({ paths });
      try {
        // This is the sole production reader of the legacy registry. Migration
        // copies and receipts it, but never mutates or writes workspaces.json.
        migrateWorkspaceRegistry(database, agentDir, paths);
        // Resume every durable human file/SQLite intent before accepting new work.
        const recoveries = database
          .prepare("SELECT DISTINCT repo_id,principal FROM task_operation WHERE status='intent'")
          .all() as Array<{ repo_id: string; principal: string }>;
        for (const recovery of recoveries)
          HumanTaskAuthority.inject(
            database,
            paths,
            recovery.repo_id,
            issueHumanCapability(recovery.principal),
          ).reconcile();
        const rootSessionId = ctx.sessionManager.getSessionId();
        const now = new Date().toISOString();
        database
          .prepare(
            "INSERT INTO pi_session(session_id,origin,cwd,first_seen_at,last_seen_at) VALUES(?,'startup',?,?,?) ON CONFLICT(session_id) DO UPDATE SET cwd=excluded.cwd,last_seen_at=excluded.last_seen_at",
          )
          .run(rootSessionId, ctx.cwd, now, now);
        const jj = new JjCli(new JjProcessExecutor());
        const custody = new SqliteWorkspaceCustody(database);
        const coordinator = new SQLiteCustodyCoordinator(database, custody, jj);
        await coordinator.recover();
        workspaces = new SQLiteWorkspaceManager({
          jj,
          custody,
          coordinator,
          sourcePath: ctx.cwd,
          workspaceRoot: paths.workspaces,
          rootSessionId,
        });
      } catch (error) {
        database.close();
        database = undefined;
        // Shared isolation does not require custody. Keep it usable while every
        // workspace operation fails closed with one bounded remediation hint.
        workspaces = unavailableWorkspaceManager(error);
      }
    }
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
      rootSessionId: ctx.sessionManager.getSessionId(),
      // Injected workspace managers are repository-test harnesses without a Pi
      // journal. Real composition fails closed when lifecycle persistence is absent.
      requireLifecycleStore: !dependencies.workspaces,
      onSettled: async (snapshot) => {
        await isolated.reclaimIfEmpty(snapshot);
      },
    });
    isolated = new IsolatedSubagents({ agents, workspaces, sourcePath: ctx.cwd });
    connectSubagentActivity(pi, agents);
    let dashboardTasks: TaskDashboardAdapter | undefined;
    if (database) {
      const cwd = resolve(ctx.cwd);
      const repo = (
        database
          .prepare(
            "SELECT repo_id,last_known_root FROM repository WHERE identity_proven=1 AND store_key IS NOT NULL",
          )
          .all() as Array<{ repo_id: string; last_known_root: string }>
      )
        .filter(({ last_known_root }) => {
          const rel = relative(resolve(last_known_root), cwd);
          return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
        })
        .sort((a, b) => b.last_known_root.length - a.last_known_root.length)[0];
      if (repo) {
        const paths = resolveStoragePaths();
        const authority = HumanTaskAuthority.inject(
          database,
          paths,
          repo.repo_id,
          issueHumanCapability(`session:${ctx.sessionManager.getSessionId()}`),
        );
        dashboardTasks = new TaskDashboardAdapter(database, repo.repo_id, authority, paths);
      }
    }
    built = {
      workspaces,
      agents,
      isolated,
      ...(database ? { database, storagePaths: resolveStoragePaths() } : {}),
      ...(dashboardTasks ? { dashboardTasks } : {}),
    };
    return built;
  }

  // Legacy shape: dependencies.registerDashboard?.(pi, () => built?.agents)
  dependencies.registerDashboard?.(
    pi,
    () => built?.agents,
    () => built?.dashboardTasks,
  );

  const taskAuthority = async (ctx: ExtensionContext) => {
    const current = await requireRuntime(ctx);
    if (!current.database || !current.storagePaths) throw new Error("Task is unavailable");
    const cwd = resolve(ctx.cwd);
    const repos = current.database
      .prepare(
        "SELECT repo_id,last_known_root FROM repository WHERE identity_proven=1 AND store_key IS NOT NULL",
      )
      .all() as Array<{ repo_id: string; last_known_root: string }>;
    const repo = repos
      .filter(({ last_known_root }) => {
        const rel = relative(resolve(last_known_root), cwd);
        return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
      })
      .sort((a, b) => b.last_known_root.length - a.last_known_root.length)[0];
    if (!repo) throw new Error("Task is unavailable");
    return new TaskAgentAuthority(
      current.database,
      current.storagePaths,
      repo.repo_id,
      `agent:${ctx.sessionManager.getSessionId()}`,
    );
  };
  const text = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: value,
  });
  pi.registerTool({
    name: "list_tasks",
    label: "List Tasks",
    description: "List unarchived ready, doing, and blocked tasks in this repository.",
    parameters: Type.Object({}),
    execute: async (_id, _p, _s, _u, ctx) => text((await taskAuthority(ctx)).list()),
  });
  pi.registerTool({
    name: "read_task",
    label: "Read Task",
    description: "Read one visible repository task and record a fixed read receipt.",
    parameters: Type.Object({ task_id: Type.String() }),
    execute: async (_id, p, _s, _u, ctx) => text((await taskAuthority(ctx)).read(p.task_id)),
  });
  pi.registerTool({
    name: "update_task",
    label: "Update Task",
    description:
      "Transition a task, append a note, or set its title. Cannot archive, reopen, drop, or revise its body.",
    parameters: Type.Object({
      task_id: Type.String(),
      action: Type.String({ enum: ["transition", "add_note", "set_title"] }),
      to: Type.Optional(Type.String({ enum: ["ready", "doing", "blocked", "done"] })),
      note: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
    }),
    execute: async (_id, p, _s, _u, ctx) =>
      text((await taskAuthority(ctx)).update(p.task_id, p as never)),
  });

  // ---- spawning -------------------------------------------------------------

  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: SPAWN_DESCRIPTION,
    promptSnippet: "Start an autonomous background subagent on a self-contained task",
    promptGuidelines: [...DELEGATION_GUIDELINES],
    parameters: Type.Object({
      objective: Type.String({
        description:
          "What the subagent must accomplish, stated so it stands alone. Text only: images and attachment objects are not inherited or forwarded.",
      }),
      isolation: Type.Union([Type.Literal("workspace"), Type.Literal("shared")], {
        description:
          "workspace: a private checkout the subagent may change. shared: your working copy, read-only.",
      }),
      capability: Type.Optional(
        Type.Union(
          CAPABILITY_NAMES.map((name) => Type.Literal(name)),
          {
            description: "Specialized environment and instructions for research tasks.",
          },
        ),
      ),
      background: Type.Optional(
        Type.String({
          description:
            "Text-only context the subagent needs but cannot discover on its own; do not pass image/attachment objects or temporary clipboard paths",
        }),
      ),
      acceptanceCriteria: Type.Optional(
        Type.Array(Type.String({ description: "A text-only completion condition" }), {
          description: "Text-only conditions that must hold for the task to be complete",
          minItems: 1,
          maxItems: 32,
        }),
      ),
      constraints: Type.Optional(
        Type.Array(Type.String({ description: "A text-only constraint" }), { maxItems: 32 }),
      ),
      backend: Type.Optional(
        Type.Union(
          enabled.map((name) => Type.Literal(name)),
          {
            description:
              "Harness to run on. Defaults to pi; choose another only when the task genuinely suits it.",
          },
        ),
      ),
      model: Type.Optional(
        Type.String({
          description: `Model alias (${MODEL_ALIAS_NAMES.join(", ")}) or an explicit provider/model id. An alias selects its harness; incompatible model/backend pairs are rejected.`,
        }),
      ),
      effort: Type.Optional(
        Type.Union(
          ["low", "medium", "high", "xhigh", "max"].map((level) => Type.Literal(level)),
          {
            description:
              "Reasoning effort. Omit this: each model has a default chosen for its purpose. " +
              "Set it only when the user asks for a different reasoning level.",
          },
        ),
      ),
      title: Type.Optional(Type.String({ description: "Short label for progress display" })),
      continue: Type.Optional(
        Type.String({
          description:
            "Id of a finished subagent whose workspace this one should pick up instead of starting a fresh checkout. Use this for coupled or sequential work in one workspace, and to hand stuck work to another model.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Reject transient clipboard references before runtime construction can
      // create a workspace, lifecycle entry, child session, or provider call.
      const promptValues = [
        params.objective,
        params.background,
        params.title,
        ...(params.acceptanceCriteria ?? []),
        ...(params.constraints ?? []),
      ].filter((value): value is string => typeof value === "string");
      if (containsTemporaryClipboardImage(promptValues, undefined, [ctx.cwd])) {
        return failure(TEMPORARY_IMAGE_ERROR);
      }

      const { isolated, agents } = await requireRuntime(ctx);
      const previous = params.continue ? agents.get(params.continue) : undefined;
      if (previous && params.capability && previous.capability !== params.capability) {
        return failure(
          `Continuation must retain capability ${previous.capability ?? "(none)"}; requested ${params.capability}.`,
        );
      }
      const capabilityName = (params.capability ?? previous?.capability) as
        | CapabilityName
        | undefined;
      const capability = capabilityName ? CAPABILITIES[capabilityName] : undefined;

      // Known aliases select their catalog backend. Explicit provider/model IDs
      // retain the configured backend unless the caller overrides it.
      const explicitAlias = params.model ? MODEL_ALIASES[params.model.toLowerCase()] : undefined;
      const selectedBackend =
        params.backend ??
        (params.model
          ? explicitAlias
            ? undefined
            : dependencies.defaultBackend
          : (capability?.backend ?? dependencies.defaultBackend));
      const resolved = resolveModel({
        ...(params.model ? { model: params.model } : capability ? { model: capability.model } : {}),
        ...(selectedBackend ? { backend: selectedBackend } : {}),
        ...(params.effort
          ? { effort: params.effort }
          : capability
            ? { effort: capability.effort }
            : {}),
      });
      if (!resolved.ok) return failure(resolved.reason);
      const { backend, provider, model, effort } = resolved.choice;
      if (capability && !capability.allowedBackends.includes(backend)) {
        return failure(
          `Capability "${capability.name}" cannot run on the ${backend} backend; use ${capability.allowedBackends.join(" or ")}.`,
        );
      }
      if (!enabled.includes(backend)) {
        return failure(`Backend "${backend}" is not enabled here. Enabled: ${enabled.join(", ")}.`);
      }
      const isolatedRun = params.isolation === "workspace";
      const title = params.title ?? firstLine(params.objective);
      let snapshot;
      try {
        snapshot = await isolated.spawn({
          backend,
          ...(capability ? { capability: capability.name } : {}),
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
          systemPrompt: (cwd) =>
            [
              composeChildCharter({
                resuming: Boolean(params.continue),
                objective: params.objective,
                cwd,
                isolated: isolatedRun,
                ...(params.acceptanceCriteria
                  ? { acceptanceCriteria: params.acceptanceCriteria }
                  : {}),
                ...(params.constraints ? { constraints: params.constraints } : {}),
              }),
              ...(capability
                ? [
                    `<capability_instructions name="${capability.name}">\n${capabilityInstructions(capability)}\n</capability_instructions>`,
                  ]
                : []),
            ].join("\n\n"),
        });
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
      return success(
        `Started ${snapshot.id} (${snapshot.backend}, ${provider}/${model}, effort ${effort})` +
          `${isolatedRun ? " in its own workspace" : " in the shared working copy"}.` +
          " Its result will arrive automatically.",
        {
          id: snapshot.id,
          backend: snapshot.backend,
          model: `${provider}/${model}`,
          effort,
          ...(snapshot.capability ? { capability: snapshot.capability } : {}),
          workspaceId: isolated.workspaceFor(snapshot.id),
        },
      );
    },
  });

  // ---- observing ------------------------------------------------------------

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait For Subagents",
    description: WAIT_DESCRIPTION,
    promptSnippet: "Block until any named subagent finishes; foreground input releases the wait",
    promptGuidelines: [...WAIT_GUIDELINES],
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: "Subagent ids to wait for",
        minItems: 1,
        maxItems: 16,
      }),
    }),
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("subagent_wait ")) +
          theme.fg("muted", args.ids.join(", ")),
        0,
        0,
      );
    },
    renderResult(result) {
      const markdown = result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      return new Markdown(markdown, 0, 0, getMarkdownTheme());
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const interruption = new AbortController();
      activeWaitInterruptions.add(interruption);
      try {
        const { agents } = await requireRuntime(ctx);
        const result = await agents.wait(params.ids, signal, interruption.signal);
        const rendered = result.settled.map(renderResult).join("\n\n---\n\n");
        const pending = result.pending.map((snapshot) => snapshot.id);
        const suffix =
          result.reason === "user-interrupted"
            ? `Wait interrupted by foreground user input; ${pending.length} subagent(s) remain running and can be collected later${pending.length ? `: ${pending.join(", ")}` : ""}.`
            : pending.length
              ? `Still running: ${pending.join(", ")}.`
              : "";
        const message = [rendered, suffix].filter(Boolean).join("\n\n");
        return success(message, {
          ids: params.ids,
          settled: result.settled.map((snapshot) => snapshot.id),
          pending,
          reason: result.reason,
        });
      } finally {
        activeWaitInterruptions.delete(interruption);
      }
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
        {
          id: snapshot.id,
          status: snapshot.status,
          ...(snapshot.capability ? { capability: snapshot.capability } : {}),
        },
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
      if (!all.length)
        return success("No subagents have been started in this session.", { count: 0 });
      return success(all.map(renderLine).join("\n"), {
        count: all.length,
        subagents: all.map((snapshot) => ({
          id: snapshot.id,
          status: snapshot.status,
          ...(snapshot.capability ? { capability: snapshot.capability } : {}),
        })),
      });
    },
  });

  // ---- steering -------------------------------------------------------------

  pi.registerTool({
    name: "subagent_send",
    label: "Send To Subagent",
    description: SEND_DESCRIPTION,
    promptSnippet: "Steer, queue input for, or continue a subagent conversation",
    parameters: Type.Object({
      id: Type.String(),
      message: Type.String({ description: "Guidance for the subagent, stated so it stands alone" }),
      mode: Type.Optional(
        Type.Union(
          [
            Type.Literal("auto"),
            Type.Literal("steer"),
            Type.Literal("followUp"),
            Type.Literal("continue"),
          ],
          { description: "Defaults to auto; explicit modes never fall back to another operation." },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { agents } = await requireRuntime(ctx);
      try {
        const receipt = await agents.send(params.id, params.message, params.mode ?? "auto");
        const message = receipt.settlementRace
          ? `${params.id} finished before your message arrived; delivered as a conversation continuation instead.`
          : receipt.operation === "steer"
            ? `Steered ${params.id} mid-run.`
            : receipt.operation === "followUp"
              ? `Queued follow-up for ${params.id}; delivered after its current work.`
              : `Continued ${params.id}'s conversation; it is running again.`;
        return success(message, { id: params.id, operation: receipt.operation });
      } catch (error) {
        return failure(describe(error));
      }
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
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { isolated } = await requireRuntime(ctx);
      let result;
      try {
        result = await isolated.merge(params.id);
      } catch (error) {
        return failure(describe(error));
      }
      if (result.kind === "blocked") return failure(result.reason);
      if (result.kind === "no_changes") {
        return success(`${params.id} produced no changes; its workspace has been removed.`, {
          merged: false,
        });
      }
      const { summary } = result;
      if (result.kind === "retained_conflicts") {
        return success(
          `Conflicts are retained in the working copy: ${summary.conflictPaths.join(", ")}. Custody of ${params.id}'s workspace is retained; resolve the conflicts, then retry workspace_merge to finalize.`,
          {
            merged: false,
            finalized: false,
            custodyRetained: true,
            strategy: summary.strategy,
            changeIds: summary.changeIds,
            conflictPaths: summary.conflictPaths,
          },
        );
      }
      return success(
        `Merged ${summary.changeIds.length} change(s) from ${params.id} using the ${summary.strategy} strategy.`,
        {
          merged: true,
          finalized: true,
          strategy: summary.strategy,
          changeIds: summary.changeIds,
          conflictPaths: summary.conflictPaths,
          parentSimplification: summary.parentSimplification,
          parentSimplificationReason: summary.parentSimplificationReason,
        },
      );
    },
  });

  pi.registerTool({
    name: "workspace_discard",
    label: "Discard Subagent Work",
    description: DISCARD_DESCRIPTION,
    promptSnippet: "Permanently throw away a subagent's workspace",
    parameters: Type.Object({
      id: Type.String({ description: "Subagent id whose workspace should be discarded" }),
    }),
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
      const lines = await Promise.all(
        records.map(async (record) => {
          const pending = await workspaces.pendingChanges(record.id).catch(() => undefined);
          return renderWorkspace(record, pending?.length);
        }),
      );
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

  const restoreCustodySafely = async (isolated: IsolatedSubagents) => {
    try {
      await isolated.restoreCustody();
    } catch {
      // A failed durable read is absence of proof, never proof of resolution.
      // Keep orphan attention and sweep protection, and expose no backend detail.
      if (typeof pi.sendMessage === "function")
        pi.sendMessage(
          {
            customType: "pi-tai-workspace-custody",
            content:
              "Managed workspace custody could not be read. It remains protected; retry after durable storage recovers, then inspect workspace_status.",
            display: true,
          },
          { deliverAs: "nextTurn", triggerTurn: false },
        );
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    const { workspaces, isolated, agents } = await requireRuntime(ctx);
    if (!dependencies.workspaces)
      await agents.attachLifecycleStore(new PiBranchLifecycleStore(pi, ctx.sessionManager));
    // Reconstitute custody from the durable workspace adapter before sweeping.
    await restoreCustodySafely(isolated);
    // Reclaim what a crashed session left behind before the model can trip over it.
    const swept = await workspaces.sweep(isolated.activeOwners()).catch(() => []);
    const attention = swept.filter((entry) => entry.disposition === "needs_attention");
    if (attention.length && typeof pi.sendMessage === "function") {
      pi.sendMessage(
        {
          customType: "pi-tai-workspace-sweep",
          content:
            `${attention.length} managed workspace(s) from an earlier session still hold unmerged work: ` +
            `${attention.map((entry) => `${entry.name} (${entry.reason})`).join("; ")}. ` +
            "Custody stays protected after reload; use workspace_status to inspect it. Unresolved or incident custody requires repair before mutation.",
          display: true,
          details: { swept },
        },
        { deliverAs: "nextTurn", triggerTurn: false },
      );
    }
  });

  // Pi can move between branches without starting a new process. Re-fold branch
  // facts while the manager safely carries its genuinely live handles forward.
  pi.on("session_tree", async (_event, ctx) => {
    const { agents, isolated } = await requireRuntime(ctx);
    if (!dependencies.workspaces)
      await agents.attachLifecycleStore(new PiBranchLifecycleStore(pi, ctx.sessionManager));
    await restoreCustodySafely(isolated);
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
    const results = agents.drainDelivery();
    if (typeof pi.sendMessage !== "function") return;
    for (const result of results) {
      const snapshot = agents.get(result.id);
      pi.sendMessage(
        {
          customType: "pi-tai-subagent-result",
          content: snapshot
            ? renderResult(snapshot)
            : `Subagent ${result.id} finished:\n${result.text}`,
          display: true,
          details: { id: result.id },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    }

    const running = agents.list().filter((snapshot) => snapshot.status === "running");
    if (!running.length) {
      reassessmentSent = false;
      return;
    }
    if (reassessmentSent) return;
    reassessmentSent = true;
    const ids = running.map((snapshot) => snapshot.id);
    pi.sendMessage(
      {
        customType: "pi-tai-subagent-wait-reassessment",
        content: `Subagents still running: ${ids.join(", ")}. Reassess whether to wait.`,
        display: false,
        details: { ids },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  });

  pi.on("session_shutdown", async () => {
    if (!runtime) return;
    const current = await runtime;
    // Agent shutdown waits for child operations and settlement hooks. SQLite is
    // closed only afterwards, and clearing composition permits a safe reopen.
    await current.agents.shutdown().catch(() => {});
    current.database?.close();
    runtime = undefined;
    built = undefined;
  });
}

function unavailableWorkspaceManager(cause: unknown): WorkspaceManagerPort {
  const detail = String(cause).replaceAll(/\s+/g, " ").slice(0, 512);
  const unavailable = () =>
    Promise.reject(
      new Error(
        `Workspace custody unavailable; isolated operations are disabled. Check the XDG state directory and state.sqlite3. ${detail}`,
      ),
    );
  return {
    create: unavailable,
    get: unavailable,
    list: unavailable,
    pendingChanges: unavailable,
    assignOwner: unavailable,
    merge: unavailable,
    discard: unavailable,
    sweep: unavailable,
  } as WorkspaceManagerPort;
}

function renderLine(snapshot: SubagentSnapshot): string {
  const context = contextUtilisation(snapshot);
  return (
    `${snapshot.id}  ${snapshot.status.padEnd(7)} ${snapshot.backend.padEnd(6)} ` +
    `${snapshot.capability ? `[${snapshot.capability}] ` : ""}` +
    `${context === undefined ? "" : `ctx ${context}%  `}${snapshot.title}`
  );
}

function renderWorkspace(record: WorkspaceRecord, pending: number | undefined): string {
  const holding =
    pending === undefined ? "unreadable" : pending === 0 ? "empty" : `${pending} change(s)`;
  const gloss: Partial<Record<WorkspaceRecord["phase"], string>> = {
    detached: "attachment gone; work retained",
    missing: "attachment and owned work not found",
    abandoned: "work deliberately discarded with receipt",
    incident: "custody needs attention",
  };
  const owner = record.ownerDisplayId ?? record.ownerId;
  const reason = record.incident?.reason;
  return `${record.name}  ${record.phase}${gloss[record.phase] ? ` (${gloss[record.phase]})` : ""}  ${holding}${owner ? `  owner ${owner}` : ""}${reason ? `  ${reason}` : ""}`;
}

function renderResult(snapshot: SubagentSnapshot): string {
  const header = `Subagent ${snapshot.id} (${snapshot.title}) ${snapshot.status === "done" ? "finished" : "failed"}.`;
  const body =
    snapshot.status === "done" ? snapshot.finalText : (snapshot.errorText ?? "No output.");
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
