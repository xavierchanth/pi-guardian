import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { CustodyEvidenceCollector, repositoryStoreKey } from "./custody-evidence.ts";
import type { CustodyRecord, RepositoryIdentity, WorkspaceCustodyPort } from "./custody-port.ts";
import { CustodyReconciler } from "./custody-reconciler.ts";
import type {
  ChangeEntry,
  MergeResult,
  MergeStrategy,
  SweepEntry,
  WorkspaceRecord,
} from "./domain.ts";
import { JjCli } from "./jj.ts";
import { type CreateWorkspaceInput, MANAGED_WORKSPACE_PREFIX } from "./manager.ts";
import { SQLiteCustodyCoordinator } from "./sqlite-custody-coordinator.ts";
import type { WorkspaceManagerPort } from "./workspace-manager-port.ts";

export interface SQLiteWorkspaceManagerOptions {
  jj: JjCli;
  custody: WorkspaceCustodyPort;
  coordinator: SQLiteCustodyCoordinator;
  sourcePath: string;
  workspaceRoot: string;
  rootSessionId: string;
  processIdentity?: string;
  now?: () => string;
}

/** WorkspaceManager-compatible facade whose durable authority is exclusively SQLite custody. */
export class SQLiteWorkspaceManager implements WorkspaceManagerPort {
  private readonly jj: JjCli;
  private readonly port: WorkspaceCustodyPort;
  private readonly coordinator: SQLiteCustodyCoordinator;
  private readonly sourcePath: string;
  private readonly workspaceRoot: string;
  private readonly rootSessionId: string;
  private readonly clock: () => string;
  private readonly reconciler: CustodyReconciler;
  private readonly collector: CustodyEvidenceCollector;
  private repository?: Promise<RepositoryIdentity>;
  private mutations: Promise<unknown> = Promise.resolve();

  constructor(o: SQLiteWorkspaceManagerOptions) {
    this.jj = o.jj;
    this.port = o.custody;
    this.coordinator = o.coordinator;
    this.sourcePath = o.sourcePath;
    this.workspaceRoot = o.workspaceRoot;
    this.rootSessionId = o.rootSessionId;
    this.clock = o.now ?? (() => new Date().toISOString());
    this.reconciler = new CustodyReconciler(this.port, {
      rootSessionId: o.rootSessionId,
      pid: process.pid,
      processIdentity: o.processIdentity ?? `${process.pid}:workspace`,
    });
    this.collector = new CustodyEvidenceCollector(this.jj, this.port);
  }

  async get(id: string) {
    const r = await this.port.get(id);
    if (!r) return undefined;
    if (r.rootSessionId === this.rootSessionId) return publicRecord(r);
    const legacy = await this.legacyIncident(r);
    return legacy ? publicRecord(legacy) : undefined;
  }
  async list() {
    const owned = await this.port.list({ rootSessionId: this.rootSessionId });
    const visible = [...owned];
    for (const row of await this.port.list()) {
      if (row.rootSessionId === this.rootSessionId || !row.repoId.startsWith("legacy_")) continue;
      const incident = await this.legacyIncident(row);
      if (incident) visible.push(incident);
    }
    return visible.map(publicRecord);
  }

  create(input: CreateWorkspaceInput = {}): Promise<WorkspaceRecord> {
    return this.serial(async () => {
      const repo = await this.repo();
      const parent = input.parent ? await this.port.get(input.parent) : undefined;
      if (
        input.parent &&
        (!parent ||
          parent.rootSessionId !== this.rootSessionId ||
          parent.disposition !== "attached")
      )
        throw new Error(`Unknown or inactive parent workspace ${input.parent}.`);
      const source = parent?.path ?? this.sourcePath;
      const bases = await this.jj.parentsOfWorkingCopy(source);
      const name = `${MANAGED_WORKSPACE_PREFIX}${slug(input.label)}-${randomUUID().slice(0, 8)}`;
      await mkdir(this.workspaceRoot, { recursive: true, mode: 0o700 });
      const at = this.clock(),
        id = `ws-${randomUUID()}`;
      const row: CustodyRecord = {
        id,
        name,
        path: join(this.workspaceRoot, name),
        repoId: repo.repoId,
        repoRoot: repo.lastKnownRoot,
        disposition: "attached",
        attachmentEvidence: "unknown",
        directoryEvidence: "unknown",
        baseChangeIds: bases,
        headChangeIds: [],
        conflictRetained: false,
        rootSessionId: this.rootSessionId,
        quarantined: false,
        attention: false,
        createdAt: at,
        updatedAt: at,
        ...(input.ownerId ? { ownerId: input.ownerId } : {}),
        ...(input.ownerDisplayId ? { ownerDisplayId: input.ownerDisplayId } : {}),
        ...(input.parent ? { parent: input.parent } : {}),
      };
      return publicRecord(
        await this.coordinator.run({
          kind: "create",
          workspaceId: id,
          repoId: repo.repoId,
          repoRoot: repo.lastKnownRoot,
          rootSessionId: this.rootSessionId,
          requestedBy: "system_spawn",
          record: row,
        }),
      );
    });
  }

  async pendingChanges(id: string): Promise<ChangeEntry[] | undefined> {
    const r = await this.port.get(id);
    if (!r || r.disposition !== "attached") return undefined;
    // A checkout and even its JJ workspace attachment are evidence, never
    // authority.  Once reconciled, durable Change IDs remain queryable from
    // any checkout in the repository.
    const heads = r.headChangeIds;
    if (!heads.length) return [];
    return (await this.jj.range(r.repoRoot, r.baseChangeIds, heads)).filter((x) => !x.empty);
  }

  assignOwner(id: string, ownerId: string, ownerDisplayId?: string): Promise<void> {
    return this.patch(
      id,
      { ownerId, ...(ownerDisplayId ? { ownerDisplayId } : {}) },
      "assign_owner",
      "system_spawn",
    );
  }
  assignParent(id: string, parent: string): Promise<void> {
    return this.patch(id, { parent }, "assign_parent", "system_spawn");
  }

  merge(id: string, _strategy: MergeStrategy = "auto"): Promise<MergeResult> {
    return this.serial(async () => {
      let r = await this.owned(id);
      if (r.disposition !== "attached")
        return {
          kind: "blocked",
          reason: `Workspace ${r.name} is ${r.disposition}, not active.`,
        };
      const checkoutPresent = await exists(r.path);
      if (checkoutPresent) {
        const head = await this.jj.changeIdAt(r.path, "@");
        const entries = await this.jj.range(r.repoRoot, r.baseChangeIds, head);
        const heads = await this.jj.headsOf(
          r.repoRoot,
          entries.map((x) => x.changeId),
        );
        r = await this.refresh(r, { headChangeIds: heads });
      }
      const entries = await this.jj.range(r.repoRoot, r.baseChangeIds, r.headChangeIds);
      const content = entries.filter((x) => !x.empty);
      if (!content.length) {
        // There can be several independent empty heads after concurrent work.
        // They are all exact owned changes, so settle them together rather than
        // feeding a multi-head row to the one-head scaffold fast path.
        const reclaimed =
          r.headChangeIds.length === 1
            ? await this.coordinator.reclaimScaffold(this.request(r))
            : await this.coordinator.run({
                ...this.request(r),
                kind: "abandon",
                requestedBy: "model_tool",
              });
        return { kind: "no_changes", record: publicRecord(reclaimed) };
      }
      const unnamed = content.filter((x) => !x.description.trim());
      if (unnamed.length)
        return {
          kind: "blocked",
          reason: `${unnamed.length} change(s) in ${r.name} have no description; describe them before merging.`,
        };
      const heads = await this.jj.headsOf(
        r.repoRoot,
        content.map((x) => x.changeId),
      );
      r = await this.refresh(r, { headChangeIds: heads });
      const parent = r.parent ? await this.owned(r.parent) : undefined;
      const targetPath = parent?.path ?? this.sourcePath;
      const target = await this.jj.changeIdAt(targetPath, "@");
      const done = await this.coordinator.run({
        ...this.request(r),
        kind: r.conflictRetained ? "finalize_merge" : "merge",
        requestedBy: "model_tool",
        targetChangeId: target,
        targetPath,
        mergeChangeIds: content.map((x) => x.changeId),
      });
      if (!done.merge) throw new Error("Coordinator completed merge without execution evidence");
      if (done.disposition === "attached")
        return {
          kind: "retained_conflicts",
          record: publicRecord(done),
          summary: done.merge,
        };
      return {
        kind: "merged",
        record: publicRecord(done),
        summary: done.merge,
      };
    });
  }

  discard(id: string): Promise<{ discardedChangeIds: readonly string[] }> {
    return this.serial(async () => {
      let r = await this.owned(id);
      const ids = [...r.headChangeIds];
      if (await exists(r.path)) {
        const head = await this.jj.changeIdAt(r.path, "@");
        const entries = await this.jj.range(r.repoRoot, r.baseChangeIds, head);
        const heads = await this.jj.headsOf(
          r.repoRoot,
          entries.map((x) => x.changeId),
        );
        r = await this.refresh(r, { headChangeIds: heads });
        ids.splice(0, ids.length, ...entries.map((x) => x.changeId));
      }
      const exactOwned = [...new Set(ids)].sort();
      // Persist every owned change (including interior and empty changes), not
      // merely graph heads: the verified receipt and public result must agree.
      r = await this.refresh(r, { headChangeIds: exactOwned });
      await this.coordinator.run({
        ...this.request(r),
        kind: "abandon",
        requestedBy: "user",
      });
      return { discardedChangeIds: exactOwned };
    });
  }

  sweep(activeOwners: readonly string[] = []): Promise<SweepEntry[]> {
    return this.serial(async () => {
      const live = new Set(activeOwners),
        out: SweepEntry[] = [];
      const currentRepo = await this.repo();
      const candidates = await this.port.list({ repoId: currentRepo.repoId });
      for (const row of await this.port.list()) {
        if (!row.repoId.startsWith("legacy_") || row.rootSessionId === this.rootSessionId) continue;
        const incident = await this.legacyIncident(row);
        if (incident) candidates.push(incident);
      }
      for (const r of candidates) {
        if (r.rootSessionId !== this.rootSessionId) {
          out.push({
            id: r.id,
            name: r.name,
            disposition: "needs_attention",
            reason: r.incident?.reason ?? "Custody belongs to another root session.",
          });
          continue;
        }
        if (r.ownerId && live.has(r.ownerId)) {
          out.push({
            id: r.id,
            name: r.name,
            disposition: "kept",
            reason: "Owner is still running.",
          });
          continue;
        }
        let rr: CustodyRecord;
        try {
          rr = await this.reconciler.reconcile(r, await this.collector.collect(r));
        } catch (error) {
          out.push({
            id: r.id,
            name: r.name,
            disposition: "needs_attention",
            reason: `Custody evidence unavailable: ${String(error)}`,
          });
          continue;
        }
        if (rr.disposition === "attached" && rr.directoryEvidence === "present") {
          const changes = await this.pendingChanges(rr.id);
          if (changes?.length) {
            out.push({
              id: r.id,
              name: r.name,
              disposition: "needs_attention",
              reason: `Holds ${changes.length} unmerged change(s) from a previous session.`,
            });
            continue;
          }
          await this.coordinator.reclaimScaffold(this.request(rr));
          out.push({
            id: r.id,
            name: r.name,
            disposition: "reclaimed",
            reason: "Workspace was empty.",
          });
        } else
          out.push({
            id: r.id,
            name: r.name,
            disposition: rr.disposition === "incident" ? "needs_attention" : "kept",
            reason: rr.incident?.reason ?? "Custody evidence retained.",
          });
      }
      return out;
    });
  }

  async resolveCustody(id: string): Promise<WorkspaceRecord | undefined> {
    const r = await this.port.get(id);
    if (!r) return undefined;
    // Collection failures are explicitly unprovable and therefore preserve
    // durable authority rather than manufacturing same-repository/hidden facts.
    try {
      return publicRecord(await this.reconciler.reconcile(r, await this.collector.collect(r)));
    } catch {
      return publicRecord(r);
    }
  }
  /** Read-only continuity bridge. It proves repository identity but deliberately
   * does not rewrite legacy custody: the prior Pi process may still be writing. */
  private async legacyIncident(r: CustodyRecord): Promise<CustodyRecord | undefined> {
    if (!r.repoId.startsWith("legacy_")) return undefined;
    try {
      const current = await this.repo();
      const root = await this.jj.repositoryRoot(r.repoRoot);
      const key = await repositoryStoreKey(root);
      if (!key || key !== current.storeKey) return undefined;
      const evidence = await this.collector.collect(r);
      const heads =
        evidence.heads.kind === "unique"
          ? evidence.heads.changeId
          : evidence.heads.kind === "multi" ||
              evidence.heads.kind === "divergent" ||
              evidence.heads.kind === "hidden"
            ? evidence.heads.changeIds?.join(",") || "none"
            : evidence.heads.kind;
      const owner = r.ownerId ?? r.ownerDisplayId ?? "unassigned";
      return {
        ...r,
        disposition: "incident",
        attention: true,
        attachmentEvidence: evidence.attachment,
        directoryEvidence: evidence.directory,
        incident: {
          stage: "legacy_custody_continuity",
          reason: `Legacy custody is visible but cannot be mutated until prior session ${r.rootSessionId} is stopped and explicit adoption exists; owner=${owner}; attachment=${evidence.attachment}; heads=${heads}; adoptable=repository_proven,liveness_unproven.`,
        },
      };
    } catch {
      // Infrastructure failure is not evidence that this legacy row belongs to
      // the current repository. Fail closed rather than leaking foreign rows.
      return undefined;
    }
  }
  private request(r: CustodyRecord) {
    return {
      workspaceId: r.id,
      repoId: r.repoId,
      repoRoot: r.repoRoot,
      rootSessionId: this.rootSessionId,
    } as const;
  }
  private async owned(id: string) {
    const r = await this.port.get(id);
    if (!r) throw new Error(`Unknown workspace ${id}.`);
    if (r.rootSessionId !== this.rootSessionId)
      throw new Error(
        `Refusing to mutate workspace ${r.name}: custody belongs to another root session (${r.rootSessionId}); stop that prior session and use an explicit adoption workflow (not yet available).`,
      );
    return r;
  }
  private patch(
    id: string,
    p: Partial<CustodyRecord>,
    kind: string,
    requestedBy: string,
  ): Promise<void> {
    return this.serial(async () => {
      const r = await this.owned(id);
      await this.refresh(r, p, kind, requestedBy);
    });
  }
  private async refresh(
    r: CustodyRecord,
    p: Partial<CustodyRecord>,
    kind = "reconcile",
    requestedBy = "system_reconcile",
  ) {
    const now = this.clock(),
      opId = `manager:${randomUUID()}`;
    await this.port.begin({
      opId,
      workspaceId: r.id,
      repoId: r.repoId,
      kind,
      requestedBy,
      pid: process.pid,
      processIdentity: `${process.pid}:workspace`,
      now,
    });
    return this.port.commit(opId, {
      workspaceId: r.id,
      ownRootSessionId: this.rootSessionId,
      cause: "heads_refreshed",
      patch: p,
      now,
    });
  }
  private repo() {
    if (!this.repository) {
      this.repository = (async () => {
        const root = await this.jj.repositoryRoot(this.sourcePath),
          evidence = await this.jj.repositoryRoots(root),
          storeKey = await repositoryStoreKey(root);
        return this.port.establishRepository({
          roots: evidence.roots,
          rootsTruncated: evidence.truncated,
          canonicalRoot: root,
          ...(storeKey ? { storeKey } : {}),
          now: this.clock(),
        });
      })();
    }
    return this.repository;
  }
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const n = this.mutations.then(f, f);
    this.mutations = n.catch(() => {});
    return n;
  }
}
function publicRecord(r: CustodyRecord): WorkspaceRecord {
  return {
    version: 2,
    id: r.id,
    name: r.name,
    path: r.path,
    repoRoot: r.repoRoot,
    phase:
      r.disposition === "attached"
        ? "active"
        : r.disposition === "detached"
          ? "detached"
          : r.disposition === "merged"
            ? "merged"
            : r.disposition === "abandoned"
              ? "abandoned"
              : r.disposition === "missing"
                ? "missing"
                : "incident",
    baseChangeIds: r.baseChangeIds,
    rootChangeId: r.rootChangeId ?? r.headChangeIds[0] ?? "",
    rootSessionId: r.rootSessionId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ...(r.ownerId ? { ownerId: r.ownerId } : {}),
    ...(r.ownerDisplayId ? { ownerDisplayId: r.ownerDisplayId } : {}),
    ...(r.parent ? { parent: r.parent } : {}),
    ...(r.merge ? { merge: r.merge } : {}),
    ...(r.incident ? { incident: r.incident } : {}),
  };
}
function slug(s?: string) {
  return (
    (s ?? "agent")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "agent"
  );
}
async function exists(p: string) {
  try {
    await stat(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
