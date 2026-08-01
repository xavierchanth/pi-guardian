import { realpath, stat } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import type { CustodyRecord, WorkspaceCustodyPort } from "./custody-port.ts";
import type { CustodyEvidence, HeadEvidence, RepositoryGrade } from "./custody-reconciler.ts";
import { CustodyReconciler } from "./custody-reconciler.ts";
import { exact, JjCli } from "./jj.ts";

/** Repository-scoped, read-only evidence. Any infrastructure error propagates. */
export class CustodyEvidenceCollector {
  private readonly jj: JjCli;
  private readonly custody: WorkspaceCustodyPort;
  private readonly db?: DatabaseSync;
  constructor(jj: JjCli, custody: WorkspaceCustodyPort, db?: DatabaseSync) {
    this.jj = jj;
    this.custody = custody;
    this.db = db;
  }

  async collect(record: CustodyRecord, now = new Date().toISOString()): Promise<CustodyEvidence> {
    const root = await this.jj.repositoryRoot(record.repoRoot);
    const roots = await this.jj.repositoryRoots(root);
    const identity = await this.custody.establishRepository({
      roots: roots.roots,
      rootsTruncated: roots.truncated,
      canonicalRoot: root,
      now,
    });
    const repository: RepositoryGrade =
      identity.repoId !== record.repoId
        ? "foreign"
        : (await realpath(record.repoRoot)) === (await realpath(root)) && root === record.repoRoot
          ? "same"
          : "relocated";
    const names = await this.jj.workspaceNames(root);
    const attachment = names.includes(record.name) ? "present" : "absent";
    let directory: "present" | "absent" = "present";
    try {
      await stat(record.path);
    } catch (error: any) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") directory = "absent";
      else throw error;
    }

    const resolutions = await Promise.all(
      record.headChangeIds.map((id) => this.jj.resolveChange(root, id)),
    );
    let heads: HeadEvidence;
    const visible = record.headChangeIds.filter((_, i) => resolutions[i]?.kind === "unique");
    const divergent = record.headChangeIds.filter((_, i) => resolutions[i]?.kind === "divergent");
    if (divergent.length) heads = { kind: "divergent", changeIds: divergent };
    else if (resolutions.some((r) => r.kind === "unknown")) heads = { kind: "unknown" };
    else if (visible.length === record.headChangeIds.length && visible.length === 1)
      heads = { kind: "unique", changeId: visible[0]! };
    else if (visible.length > 1) heads = { kind: "divergent", changeIds: visible };
    else if (resolutions.some((r) => r.kind === "hidden"))
      heads = { kind: "hidden", changeIds: record.headChangeIds };
    else heads = { kind: "absent" };

    let target: CustodyEvidence["target"];
    if (record.mergedIntoChangeId && record.headChangeIds.length) {
      target = (await this.jj.hasConflicts(root, exact(record.mergedIntoChangeId)))
        ? "conflicted"
        : (await this.jj.areAncestorsOf(root, record.headChangeIds, record.mergedIntoChangeId))
          ? "ancestor"
          : "not_ancestor";
    }
    const abandonReceipt = this.db
      ? Boolean(
          this.db
            .prepare(
              "SELECT 1 FROM abandon_receipt WHERE workspace_id=? AND verified_absent=1 AND change_ids=? LIMIT 1",
            )
            .get(record.id, JSON.stringify([...new Set(record.headChangeIds)].sort())),
        )
      : false;
    const mergeReceipt = Boolean(
      record.mergedProofOp &&
        this.db
          ?.prepare(
            "SELECT 1 FROM custody_operation WHERE op_id=? AND workspace_id=? AND state='committed' LIMIT 1",
          )
          .get(record.mergedProofOp, record.id),
    );
    return {
      repository,
      attachment,
      directory,
      heads,
      ...(target ? { target } : {}),
      abandonReceipt,
      mergeReceipt,
    };
  }
}

export type ReconcileScope = { workspaceId?: string; repoId?: string; rootSessionId?: string };
export interface ReconcileReport {
  examined: number;
  changed: number;
  diagnostics: string[];
}

/** Explicit hook facade; deliberately not wired into WorkspaceManager authority. */
export class CustodyReconciliationService {
  private readonly port: WorkspaceCustodyPort;
  private readonly collector: CustodyEvidenceCollector;
  private readonly reconciler: CustodyReconciler;
  private readonly diagnosticsLimit: number;
  constructor(
    port: WorkspaceCustodyPort,
    collector: CustodyEvidenceCollector,
    reconciler: CustodyReconciler,
    diagnosticsLimit = 20,
  ) {
    this.port = port;
    this.collector = collector;
    this.reconciler = reconciler;
    this.diagnosticsLimit = diagnosticsLimit;
  }
  async reconcile(scope: ReconcileScope = {}): Promise<ReconcileReport> {
    const rows = scope.workspaceId
      ? ([await this.port.get(scope.workspaceId)].filter(Boolean) as CustodyRecord[])
      : await this.port.list({ repoId: scope.repoId, rootSessionId: scope.rootSessionId });
    let changed = 0;
    const diagnostics: string[] = [];
    for (const row of rows)
      try {
        const after = await this.reconciler.reconcile(row, await this.collector.collect(row));
        if (after.updatedAt !== row.updatedAt) changed++;
      } catch (error) {
        if (diagnostics.length < this.diagnosticsLimit)
          diagnostics.push(`${row.id}: ${String(error)}`.slice(0, 1024));
      }
    return { examined: rows.length, changed, diagnostics };
  }
  startup = (scope?: ReconcileScope) => this.reconcile(scope);
  reload = (scope?: ReconcileScope) => this.reconcile(scope);
  preOperation = (scope?: ReconcileScope) => this.reconcile(scope);
  postOperation = (scope?: ReconcileScope) => this.reconcile(scope);
  status = (scope?: ReconcileScope) => this.reconcile(scope);
  settlement = (scope?: ReconcileScope) => this.reconcile(scope);
  tree = (scope?: ReconcileScope) => this.reconcile(scope);
  fork = (scope?: ReconcileScope) => this.reconcile(scope);
  dashboard = (scope?: ReconcileScope) => this.reconcile(scope);
}
