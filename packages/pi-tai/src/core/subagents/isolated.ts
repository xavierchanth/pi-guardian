import type { MergeResult, MergeStrategy, WorkspaceManagerPort } from "../isolation/index.ts";
import type { SubagentSnapshot } from "./domain.ts";
import type { SpawnRequest, SubagentManager } from "./manager.ts";

/**
 * The single seam between subagents and version control.
 *
 * Everything else in both modules is unaware of the other: workspaces know
 * nothing about agents, and the subagent manager only ever sees a `cwd`. This
 * class owns the two facts that connect them — spawn may need a workspace
 * first, and a settled subagent's workspace must not be left behind.
 */
export interface IsolatedSubagentsOptions {
  readonly agents: SubagentManager;
  readonly workspaces: WorkspaceManagerPort;
  /** Fallback cwd for non-isolated spawns; normally the user's own working copy. */
  readonly sourcePath: string;
}

export interface IsolatedSpawnRequest
  extends Omit<SpawnRequest, "cwd" | "workspaceId" | "systemPrompt"> {
  /**
   * `workspace` runs the child in a managed jj workspace it owns exclusively.
   * `shared` runs it in the user's working copy — read-only work only.
   */
  readonly isolation: "workspace" | "shared";
  /**
   * Accepts a function because a child's charter has to name the directory it
   * works in, and that directory does not exist until the workspace is created.
   */
  readonly systemPrompt: string | ((cwd: string) => string);
  /**
   * Reuse this subagent's workspace instead of creating one, so a fresh
   * subagent can pick up work a failed or cancelled one left behind.
   */
  readonly continueFrom?: string;
  /** Branch the new workspace from this one — the trunk of a larger run. */
  readonly parent?: string;
}

export class IsolatedSubagents {
  private readonly agents: SubagentManager;
  private readonly workspaces: WorkspaceManagerPort;
  private readonly sourcePath: string;
  /** Subagent id → workspace id, for merge/discard after the child settles. */
  private readonly owned = new Map<string, string>();

  constructor(options: IsolatedSubagentsOptions) {
    this.agents = options.agents;
    this.workspaces = options.workspaces;
    this.sourcePath = options.sourcePath;
  }

  /**
   * Creates a workspace when asked, then spawns into it.
   *
   * If the spawn fails the workspace is discarded before the error propagates —
   * the pairing that keeps a failed launch from leaking an attachment.
   */
  async spawn(request: IsolatedSpawnRequest): Promise<SubagentSnapshot> {
    // Cost optimisation only; manager.spawn remains the authoritative recheck.
    this.agents.assertAdmission();
    const { isolation, systemPrompt, continueFrom, parent, ...rest } = request;
    const render = (cwd: string) =>
      typeof systemPrompt === "function" ? systemPrompt(cwd) : systemPrompt;
    if (isolation === "shared") {
      return this.agents.spawn({
        ...rest,
        cwd: this.sourcePath,
        systemPrompt: render(this.sourcePath),
      });
    }
    const reused = continueFrom ? this.owned.get(continueFrom) : undefined;
    if (continueFrom && !reused) {
      throw new Error(
        `Subagent ${continueFrom} has no workspace to continue; it may already have been merged or discarded.`,
      );
    }
    if (reused && this.agents.get(continueFrom!)?.status === "running") {
      throw new Error(
        `Subagent ${continueFrom} is still running; cancel it before sending another subagent into its workspace.`,
      );
    }
    const existing = reused ? await this.workspaces.get(reused) : undefined;
    const workspace =
      existing ??
      (await this.workspaces.create({
        label: request.title,
        ...(parent ? { parent } : {}),
      }));
    try {
      const snapshot = await this.agents.spawn({
        ...rest,
        cwd: workspace.path,
        workspaceId: workspace.id,
        systemPrompt: render(workspace.path),
      });
      // Ownership moves to the new subagent so the old id cannot also merge it.
      if (continueFrom) {
        this.owned.delete(continueFrom);
        this.agents.resolveCustody(continueFrom);
      }
      this.owned.set(snapshot.id, workspace.id);
      // Only now does an owner exist to record, which is what lets a sweep tell
      // this workspace apart from one abandoned by a dead session.
      await this.workspaces.assignOwner(workspace.id, snapshot.durableId, snapshot.id);
      return snapshot;
    } catch (error) {
      // Only clean up a workspace this call created; a reused one holds work
      // that predates the failure and is not ours to throw away.
      if (!existing) await this.workspaces.discard(workspace.id).catch(() => {});
      throw error;
    }
  }

  /** Folds a settled subagent's workspace into the source graph. */
  async merge(subagentId: string, strategy: MergeStrategy = "auto"): Promise<MergeResult> {
    const workspaceId = this.requireWorkspace(subagentId);
    const snapshot = this.agents.get(subagentId);
    if (snapshot?.status === "running") {
      return {
        kind: "blocked",
        reason: `Subagent ${subagentId} is still running; wait or cancel it first.`,
      };
    }
    const result = await this.workspaces.merge(workspaceId, strategy);
    if (result.kind === "merged" || result.kind === "no_changes") {
      this.owned.delete(subagentId);
      this.agents.resolveCustody(subagentId);
    }
    return result;
  }

  async discard(subagentId: string): Promise<{ discardedChangeIds: readonly string[] }> {
    const workspaceId = this.requireWorkspace(subagentId);
    const result = await this.workspaces.discard(workspaceId);
    this.owned.delete(subagentId);
    this.agents.resolveCustody(subagentId);
    return result;
  }

  /** Live owners, so a workspace sweep does not reclaim work in progress. */
  activeOwners(): string[] {
    return this.agents
      .list()
      .filter((snapshot) => snapshot.status === "running")
      .map((snapshot) => snapshot.durableId);
  }

  /**
   * Reclaims the workspace of a settled subagent that produced nothing.
   *
   * Wire this to the manager's `onSettled` hook. It deliberately never merges:
   * landing an agent's changes is the orchestrator's decision, and a settle
   * hook is not the place to make it. Discarding an empty workspace loses
   * nothing, which is what makes it safe to do automatically.
   */
  async reclaimIfEmpty(snapshot: SubagentSnapshot): Promise<void> {
    const workspaceId = this.owned.get(snapshot.id);
    if (!workspaceId) return;
    const pending = await this.workspaces.pendingChanges(workspaceId).catch(() => undefined);
    if (pending === undefined) {
      // The checkout is already gone; drop the association so nothing later
      // tries to merge a workspace that does not exist.
      this.owned.delete(snapshot.id);
      this.agents.resolveCustody(snapshot.id);
      return;
    }
    if (pending.length) return; // Real work — leave it for merge or discard.
    const discarded = await this.workspaces.discard(workspaceId).then(
      () => true,
      () => false,
    );
    if (discarded) {
      this.owned.delete(snapshot.id);
      this.agents.resolveCustody(snapshot.id);
    }
  }

  workspaceFor(subagentId: string): string | undefined {
    return this.owned.get(subagentId);
  }

  private requireWorkspace(subagentId: string): string {
    const workspaceId = this.owned.get(subagentId);
    if (!workspaceId) throw new Error(`Subagent ${subagentId} has no managed workspace.`);
    return workspaceId;
  }
}
