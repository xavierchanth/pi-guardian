import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  BeginOperationInput,
  CustodyMutation,
  CustodyOperation,
  CustodyRecord,
  RepositoryEvidence,
  RepositoryIdentity,
  WorkspaceCustodyPort,
} from "./custody-port.ts";

function canonicalIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}
function parseArray(value: unknown, field: string): string[] {
  const parsed: unknown = JSON.parse(String(value));
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || !item))
    throw new Error(`Invalid ${field} in custody database`);
  return parsed;
}
function decode(r: Record<string, unknown>): CustodyRecord {
  return {
    id: String(r.id),
    name: String(r.name),
    path: String(r.path),
    repoId: String(r.repo_id),
    repoRoot: String(r.repo_root),
    disposition: r.disposition as CustodyRecord["disposition"],
    attachmentEvidence: r.attachment_evidence as CustodyRecord["attachmentEvidence"],
    directoryEvidence: r.directory_evidence as CustodyRecord["directoryEvidence"],
    ...(r.evidence_at !== null ? { evidenceAt: String(r.evidence_at) } : {}),
    baseChangeIds: parseArray(r.base_change_ids, "base_change_ids"),
    ...(r.root_change_id !== null ? { rootChangeId: String(r.root_change_id) } : {}),
    headChangeIds: parseArray(r.head_change_ids, "head_change_ids"),
    ...(r.merged_into_change_id !== null
      ? { mergedIntoChangeId: String(r.merged_into_change_id) }
      : {}),
    ...(r.merged_proof_op !== null ? { mergedProofOp: String(r.merged_proof_op) } : {}),
    conflictRetained: Boolean(r.conflict_retained),
    ...(r.owner_id !== null ? { ownerId: String(r.owner_id) } : {}),
    ...(r.owner_display_id !== null ? { ownerDisplayId: String(r.owner_display_id) } : {}),
    ...(r.anchor_token !== null ? { anchorToken: String(r.anchor_token) } : {}),
    rootSessionId: String(r.root_session_id),
    ...(r.parent_workspace_id !== null ? { parent: String(r.parent_workspace_id) } : {}),
    ...(r.pending_op_id !== null ? { pendingOpId: String(r.pending_op_id) } : {}),
    quarantined: Boolean(r.quarantined),
    attention: Boolean(r.attention),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    ...(r.incident_stage !== null
      ? { incident: { stage: String(r.incident_stage), reason: String(r.incident_reason) } }
      : {}),
    ...(r.merge_json !== null ? { merge: JSON.parse(String(r.merge_json)) } : {}),
  };
}

const PATCH_COLUMNS: Record<string, string> = {
  name: "name",
  path: "path",
  repoId: "repo_id",
  repoRoot: "repo_root",
  attachmentEvidence: "attachment_evidence",
  directoryEvidence: "directory_evidence",
  evidenceAt: "evidence_at",
  baseChangeIds: "base_change_ids",
  rootChangeId: "root_change_id",
  headChangeIds: "head_change_ids",
  mergedIntoChangeId: "merged_into_change_id",
  mergedProofOp: "merged_proof_op",
  conflictRetained: "conflict_retained",
  ownerId: "owner_id",
  ownerDisplayId: "owner_display_id",
  anchorToken: "anchor_token",
  parent: "parent_workspace_id",
  pendingOpId: "pending_op_id",
  quarantined: "quarantined",
  attention: "attention",
  incident: "incident_stage",
  merge: "merge_json",
};
const jsonFields = new Set(["baseChangeIds", "headChangeIds", "merge"]);
const boolFields = new Set(["conflictRetained", "quarantined", "attention"]);

export class SqliteWorkspaceCustody implements WorkspaceCustodyPort {
  private readonly db: DatabaseSync;
  private readonly clock: () => string;
  constructor(db: DatabaseSync, clock: () => string = () => new Date().toISOString()) {
    this.db = db;
    this.clock = clock;
  }
  async establishRepository(e: RepositoryEvidence): Promise<RepositoryIdentity> {
    if (!e.canonicalRoot.startsWith("/") || (!e.storeKey && !e.roots.length))
      throw new Error("Repository identity requires a canonical root and durable JJ evidence");
    const roots = [...new Set(e.roots)];
    if (roots.some((id) => !/^[k-z]{4,64}$/.test(id)))
      throw new Error("Invalid repository root Change ID");
    roots.sort();
    // Store identity is authoritative and path independent.  Root evidence is
    // deliberately graded by overlap/containment: ordinary history growth must
    // never manufacture a second repository merely because its root set grew.
    const candidates = this.db
      .prepare("SELECT * FROM repository WHERE identity_proven=1")
      .all() as Record<string, unknown>[];
    const input = new Set(roots);
    const matches = candidates.filter((row) => {
      if (e.storeKey && row.store_key !== null) return String(row.store_key) === e.storeKey;
      const prior = new Set<string>((JSON.parse(String(row.fingerprint))?.roots ?? []) as string[]);
      const overlap = [...input].some((id) => prior.has(id));
      const contained =
        [...input].every((id) => prior.has(id)) || [...prior].every((id) => input.has(id));
      return overlap || contained;
    });
    if (matches.length > 1) throw new Error("Ambiguous repository identity evidence");
    const matched = matches[0];
    const fingerprint = JSON.stringify({
      v: 1,
      roots,
      ...(e.storeKey ? { storeKey: e.storeKey } : {}),
    });
    const repoId = matched
      ? String(matched.repo_id)
      : `repo_${createHash("sha256")
          .update(e.storeKey ?? fingerprint)
          .digest("hex")
          .slice(0, 32)}`;
    if (matched)
      this.db
        .prepare(
          "UPDATE repository SET fingerprint=?,roots_truncated=?,store_key=coalesce(store_key,?),last_known_root=?,last_verified_at=? WHERE repo_id=?",
        )
        .run(
          fingerprint,
          e.rootsTruncated ? 1 : 0,
          e.storeKey ?? null,
          e.canonicalRoot,
          e.now,
          repoId,
        );
    else
      this.db
        .prepare(
          "INSERT INTO repository(repo_id,fingerprint,roots_truncated,store_key,last_known_root,identity_proven,first_seen_at,last_verified_at) VALUES(?,?,?,?,?,1,?,?)",
        )
        .run(
          repoId,
          fingerprint,
          e.rootsTruncated ? 1 : 0,
          e.storeKey ?? null,
          e.canonicalRoot,
          e.now,
          e.now,
        );
    const row = this.db.prepare("SELECT * FROM repository WHERE repo_id=?").get(repoId) as Record<
      string,
      unknown
    >;
    return {
      repoId: String(row.repo_id),
      fingerprint: String(row.fingerprint),
      rootsTruncated: Boolean(row.roots_truncated),
      ...(row.store_key !== null ? { storeKey: String(row.store_key) } : {}),
      lastKnownRoot: String(row.last_known_root),
      identityProven: Boolean(row.identity_proven),
      firstSeenAt: String(row.first_seen_at),
      lastVerifiedAt: String(row.last_verified_at),
    };
  }
  async insert(r: CustodyRecord, operation: BeginOperationInput): Promise<CustodyRecord> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      await this.begin(operation);
      this.db
        .prepare(
          "INSERT INTO workspace(id,name,path,repo_id,repo_root,disposition,attachment_evidence,directory_evidence,evidence_at,base_change_ids,root_change_id,head_change_ids,merged_into_change_id,merged_proof_op,conflict_retained,owner_id,owner_display_id,anchor_token,root_session_id,parent_workspace_id,pending_op_id,quarantined,attention,created_at,updated_at,incident_stage,incident_reason,merge_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          r.id,
          r.name,
          r.path,
          r.repoId,
          r.repoRoot,
          r.disposition,
          r.attachmentEvidence,
          r.directoryEvidence,
          r.evidenceAt ?? null,
          JSON.stringify(r.baseChangeIds),
          r.rootChangeId ?? null,
          JSON.stringify(canonicalIds(r.headChangeIds)),
          r.mergedIntoChangeId ?? null,
          r.mergedProofOp ?? null,
          r.conflictRetained ? 1 : 0,
          r.ownerId ?? null,
          r.ownerDisplayId ?? null,
          r.anchorToken ?? null,
          r.rootSessionId,
          r.parent ?? null,
          operation.opId,
          r.quarantined ? 1 : 0,
          r.attention ? 1 : 0,
          r.createdAt,
          r.updatedAt,
          r.incident?.stage ?? null,
          r.incident?.reason ?? null,
          r.merge ? JSON.stringify(r.merge) : null,
        );
      this.db
        .prepare("INSERT INTO custody_event VALUES(?,1,?,NULL,?,'create',?)")
        .run(operation.opId, r.id, r.disposition, operation.now);
      this.db
        .prepare(
          "UPDATE custody_operation SET state='committed',settled_at=?,heartbeat_at=? WHERE op_id=?",
        )
        .run(operation.now, operation.now, operation.opId);
      this.db.prepare("UPDATE workspace SET pending_op_id=NULL WHERE id=?").run(r.id);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
    return (await this.get(r.id))!;
  }
  async list(f?: {
    rootSessionId?: string;
    repoId?: string;
    dispositions?: readonly CustodyRecord["disposition"][];
  }): Promise<CustodyRecord[]> {
    const where: string[] = [],
      args: string[] = [];
    if (f?.rootSessionId) {
      where.push("root_session_id=?");
      args.push(f.rootSessionId);
    }
    if (f?.repoId) {
      where.push("repo_id=?");
      args.push(f.repoId);
    }
    if (f?.dispositions?.length) {
      where.push(`disposition IN (${f.dispositions.map(() => "?").join(",")})`);
      args.push(...f.dispositions);
    }
    return (
      this.db
        .prepare(`SELECT * FROM workspace${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`)
        .all(...args) as Record<string, unknown>[]
    ).map(decode);
  }
  async get(id: string) {
    const r = this.db.prepare("SELECT * FROM workspace WHERE id=?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? decode(r) : undefined;
  }
  async begin(i: BeginOperationInput) {
    if (!i.opId || !i.processIdentity) throw new Error("Operation identity must not be empty");
    this.db
      .prepare(
        "INSERT INTO custody_operation(op_id,workspace_id,repo_id,kind,state,requested_by,pid,process_identity,change_ids,started_at,heartbeat_at) VALUES(?,?,?,?,'intent',?,?,?,?,?,?)",
      )
      .run(
        i.opId,
        i.workspaceId ?? null,
        i.repoId ?? null,
        i.kind,
        i.requestedBy,
        i.pid,
        i.processIdentity,
        i.changeIds ? JSON.stringify([...i.changeIds].sort()) : null,
        i.now,
        i.now,
      );
    return { ...i, state: "intent" } as CustodyOperation;
  }
  async commit(opId: string, m: CustodyMutation) {
    let begun = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      begun = true;
      const oldRow = this.db.prepare("SELECT * FROM workspace WHERE id=?").get(m.workspaceId) as
        | Record<string, unknown>
        | undefined;
      if (!oldRow) throw new Error("Unknown custody row");
      const old = decode(oldRow),
        to = m.disposition ?? old.disposition;
      const operation = this.db
        .prepare("SELECT state,workspace_id FROM custody_operation WHERE op_id=?")
        .get(opId) as { state: string; workspace_id: string | null } | undefined;
      if (
        !operation ||
        operation.state !== "intent" ||
        (operation.workspace_id && operation.workspace_id !== m.workspaceId)
      )
        throw new Error("Custody operation is not an applicable intent");
      const seq = Number(
        (
          this.db
            .prepare("SELECT COALESCE(MAX(seq),0)+1 n FROM custody_event WHERE op_id=?")
            .get(opId) as { n: number }
        ).n,
      );
      this.db
        .prepare("INSERT INTO custody_event VALUES(?,?,?,?,?,?,?)")
        .run(opId, seq, m.workspaceId, old.disposition, to, m.cause, m.now);
      const sets = ["updated_at=?", "pending_op_id=NULL"],
        values: SQLInputValue[] = [m.now];
      // Evidence-only refreshes must not fire disposition transition/abandon triggers.
      if (to !== old.disposition) {
        sets.unshift("disposition=?");
        values.unshift(to);
      }
      for (const [key, value] of Object.entries(m.patch ?? {})) {
        if (
          key === "id" ||
          key === "rootSessionId" ||
          key === "createdAt" ||
          key === "updatedAt" ||
          key === "disposition"
        )
          continue;
        const column = PATCH_COLUMNS[key];
        if (!column) continue;
        if (key === "incident") {
          sets.push("incident_stage=?", "incident_reason=?");
          const incident = value as CustodyRecord["incident"];
          values.push(incident?.stage ?? null, incident?.reason ?? null);
          continue;
        }
        sets.push(`${column}=?`);
        const storageValue =
          key === "headChangeIds" && Array.isArray(value) ? canonicalIds(value) : value;
        values.push(
          storageValue === undefined
            ? null
            : jsonFields.has(key)
              ? JSON.stringify(storageValue)
              : boolFields.has(key)
                ? value
                  ? 1
                  : 0
                : (value as SQLInputValue),
        );
      }
      values.push(m.workspaceId, m.ownRootSessionId);
      const result = this.db
        .prepare(`UPDATE workspace SET ${sets.join(",")} WHERE id=? AND root_session_id=?`)
        .run(...values);
      if (result.changes !== 1) throw new Error("Custody mutation refused: foreign root");
      this.db
        .prepare(
          "UPDATE custody_operation SET state='committed',settled_at=?,heartbeat_at=? WHERE op_id=?",
        )
        .run(m.now, m.now, opId);
      this.db.exec("COMMIT");
      begun = false;
    } catch (e) {
      if (begun)
        try {
          this.db.exec("ROLLBACK");
        } catch {}
      throw e;
    }
    return (await this.get(m.workspaceId))!;
  }
  async fail(opId: string, evidence: string) {
    const now = this.clock();
    this.db
      .prepare(
        "UPDATE custody_operation SET state='failed',settled_at=?,heartbeat_at=?,evidence=? WHERE op_id=?",
      )
      .run(now, now, evidence.slice(0, 8192), opId);
  }
  async recordAbandonReceipt(
    opId: string,
    r: Parameters<WorkspaceCustodyPort["recordAbandonReceipt"]>[1],
  ) {
    if (!r.changeIds.length) throw new Error("Abandon receipt requires canonical heads");
    if (!r.verifiedAbsent) throw new Error("Abandon receipt requires verified_absent evidence");
    const ids = [...new Set(r.changeIds)].sort();
    this.db
      .prepare("INSERT INTO abandon_receipt VALUES(?,?,?,?,?,?,?,1,?)")
      .run(
        r.receiptId,
        r.workspaceId,
        opId,
        r.requestedBy,
        JSON.stringify(ids),
        r.jjOpBefore,
        r.jjOpAfter,
        r.at,
      );
  }
  async openOperations(f?: { repoId?: string }) {
    const rows = this.db
      .prepare(
        `SELECT op_id AS opId,workspace_id AS workspaceId,repo_id AS repoId,kind,state,requested_by AS requestedBy,pid,process_identity AS processIdentity,change_ids AS changeIds,started_at AS now FROM custody_operation WHERE state IN('intent','jj_applied','unknown')${f?.repoId ? " AND repo_id=?" : ""}`,
      )
      .all(...(f?.repoId ? [f.repoId] : [])) as Record<string, unknown>[];
    return rows.map((r) => ({
      ...r,
      changeIds: r.changeIds === null ? undefined : parseArray(r.changeIds, "change_ids"),
    })) as unknown as CustodyOperation[];
  }
  async heartbeat(opId: string) {
    this.db
      .prepare("UPDATE custody_operation SET heartbeat_at=? WHERE op_id=?")
      .run(this.clock(), opId);
  }
}
