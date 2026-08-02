import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  ChangeEntry,
  MergeResult,
  MergeSummary,
  SweepEntry,
  WorkspaceId,
  WorkspaceRecord,
} from "./domain.ts";
import { JjCli } from "./jj.ts";
import type { WorkspaceRegistryPort } from "./registry.ts";

/** Managed workspace names carry this prefix so a sweep can recognise its own. */
export const MANAGED_WORKSPACE_PREFIX = "pitai-";

export interface WorkspaceManagerOptions {
  readonly jj: JjCli;
  readonly registry: WorkspaceRegistryPort;
  /** The user's own working copy: the source graph everything merges into. */
  readonly sourcePath: string;
  /** Directory that holds managed workspace checkouts, outside the repository. */
  readonly workspaceRoot: string;
  /** Durable identity of the current top-level Pi session. */
  readonly rootSessionId?: string;
  readonly now?: () => string;
}

export interface CreateWorkspaceInput {
  /** Short slug used to build the workspace name; defaults to a random suffix. */
  readonly label?: string;
  readonly ownerId?: string;
  readonly ownerDisplayId?: string;
  /** Branch from this workspace instead of the user's working copy. */
  readonly parent?: WorkspaceId;
}

/**
 * Creates, merges and reclaims managed JJ workspaces.
 *
 * The module owns no agent concepts: a workspace is just a directory plus a
 * change range, and `owner` is an opaque label. That keeps the failure modes of
 * version control separable from the failure modes of spawning processes.
 */
export class WorkspaceManager {
  private readonly jj: JjCli;
  private readonly registry: WorkspaceRegistryPort;
  private readonly sourcePath: string;
  private readonly workspaceRoot: string;
  private readonly clock: () => string;
  private readonly rootSessionId: string;
  /** Serialises graph mutations; jj rejects concurrent writes to one repo. */
  private mutations: Promise<unknown> = Promise.resolve();

  constructor(options: WorkspaceManagerOptions) {
    this.jj = options.jj;
    this.registry = options.registry;
    this.sourcePath = options.sourcePath;
    this.workspaceRoot = options.workspaceRoot;
    // Tests which do not care about custody still get an opaque, non-colliding root.
    this.rootSessionId = options.rootSessionId ?? randomUUID();
    this.clock = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Checkout a workspace branches from and merges into: its parent's, or the
   * user's when it has no parent.
   */
  private async sourceFor(parent: WorkspaceId | undefined): Promise<string> {
    if (!parent) return this.sourcePath;
    const record = await this.registry.get(parent);
    if (!record) throw new Error(`Unknown parent workspace ${parent}.`);
    this.assertCustody(record);
    if (record.phase !== "active")
      throw new Error(`Parent workspace ${record.name} is ${record.phase}, not active.`);
    return record.path;
  }

  list(): Promise<WorkspaceRecord[]> {
    return this.registry.list();
  }

  get(id: WorkspaceId): Promise<WorkspaceRecord | undefined> {
    return this.registry.get(id);
  }

  /**
   * Allocates a workspace whose root has the same parents as the source `@`.
   *
   * Cleanup is part of the operation: if any step after `workspace add` fails,
   * the attachment and directory are removed before the error propagates, so a
   * failed create cannot leak a half-built workspace.
   */
  create(input: CreateWorkspaceInput = {}): Promise<WorkspaceRecord> {
    return this.serialise(async () => {
      const source = await this.sourceFor(input.parent);
      const repoRoot = await this.jj.repositoryRoot(source);
      const baseChangeIds = await this.jj.parentsOfWorkingCopy(source);
      const name = `${MANAGED_WORKSPACE_PREFIX}${slug(input.label)}-${randomUUID().slice(0, 8)}`;
      const path = join(this.workspaceRoot, name);
      await mkdir(this.workspaceRoot, { recursive: true, mode: 0o700 });
      await this.jj.workspaceAdd(source, path, name, baseChangeIds);
      try {
        const rootChangeId = await this.jj.changeIdAt(path, "@");
        const at = this.clock();
        const record: WorkspaceRecord = {
          version: 2,
          id: `ws-${randomUUID()}`,
          name,
          path,
          repoRoot,
          phase: "active",
          baseChangeIds,
          rootChangeId,
          rootSessionId: this.rootSessionId,
          ...(input.ownerId ? { ownerId: input.ownerId } : {}),
          ...(input.ownerDisplayId ? { ownerDisplayId: input.ownerDisplayId } : {}),
          ...(input.parent ? { parent: input.parent } : {}),
          createdAt: at,
          updatedAt: at,
        };
        await this.registry.put(record);
        return record;
      } catch (error) {
        await this.detach(name, path, source);
        throw error;
      }
    });
  }

  /**
   * Folds a workspace's changes into the source graph and removes it.
   *
   * `auto` picks the linear insert only when it is unambiguously safe — the
   * user's `@` is empty and has a single parent — and otherwise merges the agent
   * head under `@`. A linear attempt that produces conflicts is undone and
   * retried as a merge, because conflicts are tractable in a live working copy
   * and painful inside a rewritten range.
   */
  merge(id: WorkspaceId): Promise<MergeResult> {
    return this.serialise(async () => {
      const record = await this.registry.get(id);
      if (!record) return { kind: "blocked", reason: `Unknown workspace ${id}.` } as const;
      if (!this.hasCustody(record)) {
        return {
          kind: "blocked",
          reason: `Workspace ${record.name} is owned by another or legacy root.`,
        } as const;
      }
      if (record.phase !== "active") {
        return {
          kind: "blocked",
          reason: `Workspace ${record.name} is ${record.phase}, not active.`,
        } as const;
      }
      if (!(await pathExists(record.path))) {
        return {
          kind: "blocked",
          reason: `Workspace directory ${record.path} is missing; run a sweep.`,
        } as const;
      }

      const head = await this.jj.changeIdAt(record.path, "@");
      const entries = await this.jj.range(record.path, record.baseChangeIds, head);
      const content = entries.filter((entry) => !entry.empty);
      if (!content.length) {
        await this.reclaim(record, entries);
        return { kind: "no_changes", record } as const;
      }
      const unnamed = content.filter((entry) => !entry.description.trim());
      if (unnamed.length) {
        return {
          kind: "blocked",
          reason: `${unnamed.length} change(s) in ${record.name} have no description; describe them before merging.`,
        } as const;
      }

      const target = await this.sourceFor(record.parent);
      const summary = await this.mergeUnder(record, content, entries, target);
      if (summary.conflictPaths.length) {
        return { kind: "retained_conflicts", record, summary } as const;
      }
      return {
        kind: "merged",
        record: { ...record, phase: "merged", updatedAt: this.clock(), merge: summary },
        summary,
      } as const;
    });
  }

  /**
   * Records who a workspace belongs to.
   *
   * Ownership is assigned after creation because the owner — a subagent id —
   * does not exist until the child has been spawned into the workspace. Until
   * then the workspace is unowned, and a sweep would treat it as reclaimable.
   */
  assignOwner(id: WorkspaceId, ownerId: string, ownerDisplayId?: string): Promise<void> {
    return this.serialise(async () => {
      const record = await this.registry.get(id);
      if (!record) throw new Error(`Unknown workspace ${id}.`);
      this.assertCustody(record);
      await this.registry.put({
        ...record,
        ownerId,
        ...(ownerDisplayId ? { ownerDisplayId } : {}),
        updatedAt: this.clock(),
      });
    });
  }

  /**
   * The described, non-empty changes a workspace is holding.
   *
   * Read-only: callers use it to decide whether a workspace is worth merging
   * without committing to either outcome. Returns `undefined` when the
   * workspace is unknown or its checkout is gone.
   */
  async pendingChanges(id: WorkspaceId): Promise<ChangeEntry[] | undefined> {
    const record = await this.registry.get(id);
    if (!record || record.phase !== "active" || !(await pathExists(record.path))) return undefined;
    const entries = await this.jj.range(
      record.path,
      record.baseChangeIds,
      await this.jj.changeIdAt(record.path, "@"),
    );
    return entries.filter((entry) => !entry.empty);
  }

  /** Throws the workspace away, abandoning its changes so they do not litter the graph. */
  discard(id: WorkspaceId): Promise<{ discardedChangeIds: readonly string[] }> {
    return this.serialise(async () => {
      const record = await this.registry.get(id);
      if (!record) throw new Error(`Unknown workspace ${id}.`);
      this.assertCustody(record);
      const entries = (await pathExists(record.path))
        ? await this.jj.range(
            record.path,
            record.baseChangeIds,
            await this.jj.changeIdAt(record.path, "@"),
          )
        : [];
      await this.reclaim(record, entries);
      return { discardedChangeIds: entries.map((entry) => entry.changeId) };
    });
  }

  /**
   * Reconciles the registry against reality at startup.
   *
   * Workspaces belonging to `activeOwners` are left alone; anything else that
   * holds no content is reclaimed automatically, and anything holding work is
   * reported for a human decision rather than deleted.
   */
  sweep(activeOwners: readonly string[] = []): Promise<SweepEntry[]> {
    return this.serialise(async () => {
      const live = new Set(activeOwners);
      const results: SweepEntry[] = [];
      const records = await this.registry.list();
      const known = new Set(records.map((record) => record.name));

      for (const record of records) {
        // Version 1 has no durable/root authority and can never be adopted.
        if (record.version !== 2 || !("rootSessionId" in record)) {
          results.push({
            id: record.id,
            name: record.name,
            disposition: "needs_attention",
            reason: "Legacy custody record is quarantined.",
          });
          continue;
        }
        if (record.rootSessionId !== this.rootSessionId) {
          results.push({
            id: record.id,
            name: record.name,
            disposition: "kept",
            reason: "Owned by a different root session.",
          });
          continue;
        }
        if (record.phase === "incident") {
          results.push({
            id: record.id,
            name: record.name,
            disposition: "needs_attention",
            reason: record.incident?.reason ?? "Incident record.",
          });
          continue;
        }
        if (record.ownerId && live.has(record.ownerId)) {
          results.push({
            id: record.id,
            name: record.name,
            disposition: "kept",
            reason: "Owner is still running.",
          });
          continue;
        }
        if (!(await pathExists(record.path))) {
          await this.detach(record.name, record.path, await this.sourceFor(record.parent));
          await this.registry.remove(record.id);
          results.push({
            id: record.id,
            name: record.name,
            disposition: "reclaimed",
            reason: "Workspace directory no longer exists.",
          });
          continue;
        }
        const entries = await this.jj.range(
          record.path,
          record.baseChangeIds,
          await this.jj.changeIdAt(record.path, "@"),
        );
        if (entries.some((entry) => !entry.empty)) {
          results.push({
            id: record.id,
            name: record.name,
            disposition: "needs_attention",
            reason: `Holds ${entries.filter((entry) => !entry.empty).length} unmerged change(s) from a previous session.`,
          });
          continue;
        }
        await this.reclaim(record, entries);
        results.push({
          id: record.id,
          name: record.name,
          disposition: "reclaimed",
          reason: "Workspace was empty.",
        });
      }

      // Attachments this module created but never recorded — the classic crash-between
      // `workspace add` and the registry write.
      for (const name of await this.jj.workspaceNames(this.sourcePath)) {
        if (!name.startsWith(MANAGED_WORKSPACE_PREFIX) || known.has(name)) continue;
        results.push({
          id: name,
          name,
          disposition: "needs_attention",
          reason: "Unknown managed attachment; ownership cannot be proven.",
        });
      }
      return results;
    });
  }

  private async mergeUnder(
    record: WorkspaceRecord,
    content: readonly ChangeEntry[],
    entries: readonly ChangeEntry[],
    target: string,
  ): Promise<MergeSummary> {
    const changeIds = content.map((entry) => entry.changeId);
    // Every head, not just the newest change: a workspace that collected work
    // from concurrent subagents holds independent chains, and one merge parent
    // per chain is what keeps them all reachable.
    const heads = await this.jj.headsOf(record.path, changeIds);

    // A retry after conflict resolution must not invoke rebase again. Prove that
    // every retained source head is already in the target, then either retain
    // custody while conflicts remain or finalize by detaching the recovery copy.
    const targetBefore = await this.jj.changeIdAt(target, "@");
    if (await this.jj.areAncestorsOf(target, heads, targetBefore)) {
      const conflictPaths = await this.jj.conflictedPaths(target);
      const summary: MergeSummary = {
        strategy: "merge-under",
        changeIds,
        conflictPaths,
        parentSimplification: "skipped",
        parentSimplificationReason: "no-redundancy",
      };
      if (!conflictPaths.length) await this.reclaim(record, entries, target);
      return summary;
    }

    await this.jj.updateStale(target, "legacy merge target");
    const parents = await this.jj.parentsOfWorkingCopy(target);
    // User-authored redundant edges are intentional graph shape. A failed probe
    // is also a reason to leave topology alone, never a reason to fail merging.
    let redundancyExisted: boolean | undefined;
    try {
      const targetBefore = await this.jj.changeIdAt(target, "@");
      redundancyExisted = await this.jj.hasRedundantParents(target, targetBefore);
    } catch {
      /* cosmetic probe failure: conservatively skip */
    }
    // `@` keeps every parent it already had and gains the agent head, so repeated
    // merges accumulate rather than replace.
    await this.jj.rebaseWorkingCopyOnto(target, [...parents, ...heads]);

    let parentSimplification: MergeSummary["parentSimplification"] = "skipped";
    let parentSimplificationReason: NonNullable<MergeSummary["parentSimplificationReason"]> =
      redundancyExisted === undefined
        ? "precheck-failed"
        : redundancyExisted
          ? "pre-existing-redundancy"
          : "no-redundancy";
    if (redundancyExisted === false) {
      let operationBefore: string | undefined;
      let simplifyOperation: string | undefined;
      try {
        const mergedTarget = await this.jj.changeIdAt(target, "@");
        if (!(await this.jj.hasRedundantParents(target, mergedTarget))) {
          parentSimplificationReason = "no-redundancy";
        } else if (await this.jj.hasDescendants(target, mergedTarget)) {
          parentSimplificationReason = "has-descendants";
        } else {
          operationBefore = await this.jj.currentOperationId(target);
          await this.jj.simplifyParents(target, mergedTarget);
          simplifyOperation = await this.jj.currentOperationId(target);
          const simplifiedTarget = await this.jj.changeIdAt(target, "@");
          if (
            (await this.jj.hasRedundantParents(target, simplifiedTarget)) ||
            !(await this.jj.areAncestorsOf(target, heads, simplifiedTarget))
          ) {
            throw new Error("postcheck-failed");
          }
          parentSimplification = "applied";
          parentSimplificationReason = "redundant-parents-removed";
        }
      } catch (error) {
        parentSimplification = "failed";
        const failureReason =
          error instanceof Error && error.message === "postcheck-failed"
            ? "postcheck-failed"
            : "cosmetic-command-failed";
        parentSimplificationReason = failureReason;
        // A repository-wide restore is safe only while the operation produced by
        // our successful simplify is still current. Otherwise unrelated work may
        // have intervened, and retaining redundant parents is strictly safer.
        if (operationBefore && simplifyOperation && simplifyOperation !== operationBefore) {
          try {
            if ((await this.jj.currentOperationId(target)) === simplifyOperation) {
              await this.jj.restoreOperation(target, operationBefore);
              parentSimplificationReason = `${failureReason}-rolled-back`;
            } else {
              parentSimplificationReason = `${failureReason}-rollback-skipped-intervening-operation`;
            }
          } catch {
            parentSimplificationReason = `${failureReason}-rollback-failed`;
          }
        }
      }
    }
    const conflictPaths = await this.jj.conflictedPaths(target);
    // Conflicts live in the target, but source custody remains the durable
    // recovery copy until a later retry observes a resolved target.
    if (!conflictPaths.length) await this.reclaim(record, entries, target);
    return {
      strategy: "merge-under",
      changeIds,
      conflictPaths,
      parentSimplification,
      parentSimplificationReason,
    };
  }

  /**
   * Detaches a workspace and abandons whatever empty scaffolding it leaves in the
   * graph. Detaching first matters: jj refuses to abandon a live working copy.
   */
  private async reclaim(
    record: WorkspaceRecord,
    entries: readonly ChangeEntry[],
    target?: string,
  ): Promise<void> {
    const source = target ?? (await this.sourceFor(record.parent));
    await this.detach(record.name, record.path, source);
    for (const entry of entries) {
      if (!entry.empty) continue;
      try {
        await this.jj.abandon(source, entry.changeId);
      } catch {
        // The change may already be gone (moved, or abandoned with its parent).
        // Leftover empties are cosmetic; failing the merge over them is not.
      }
    }
    await this.registry.remove(record.id);
  }

  private async detach(name: string, path: string, source: string): Promise<void> {
    try {
      if (await pathExists(path)) await this.jj.updateStale(path, "legacy workspace detach");
      await this.jj.workspaceForget(source, name);
    } catch (error) {
      throw new Error(
        `Failed to detach workspace ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await rm(path, { recursive: true, force: true });
  }

  private hasCustody(record: WorkspaceRecord): boolean {
    return record.version === 2 && record.rootSessionId === this.rootSessionId;
  }

  private assertCustody(record: WorkspaceRecord): void {
    if (!this.hasCustody(record)) {
      throw new Error(
        `Refusing to mutate workspace ${record.name}: custody belongs to another or legacy root.`,
      );
    }
  }

  private serialise<T>(operation: () => Promise<T>): Promise<T> {
    // Lock ordering is always process-local queue -> operation lock -> registry
    // RMW lock. Registry methods never acquire the operation lock themselves.
    const guarded = () => this.registry.withOperationLock(operation);
    const next = this.mutations.then(guarded, guarded);
    this.mutations = next.catch(() => {});
    return next;
  }
}

function slug(label: string | undefined): string {
  const cleaned = (label ?? "agent")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 24) || "agent";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
