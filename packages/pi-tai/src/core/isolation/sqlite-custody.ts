import type { DatabaseSync } from "node:sqlite";
import type {
  BeginOperationInput,
  CustodyMutation,
  CustodyOperation,
  CustodyRecord,
  WorkspaceCustodyPort,
} from "./custody-port.ts";
function decode(r: Record<string, unknown>): CustodyRecord {
  const json = (v: unknown) => JSON.parse(String(v)) as string[];
  return {
    id: String(r.id),
    name: String(r.name),
    path: String(r.path),
    repoId: String(r.repo_id),
    repoRoot: String(r.repo_root),
    disposition: r.disposition as CustodyRecord["disposition"],
    attachmentEvidence: r.attachment_evidence as CustodyRecord["attachmentEvidence"],
    directoryEvidence: r.directory_evidence as CustodyRecord["directoryEvidence"],
    ...(r.evidence_at ? { evidenceAt: String(r.evidence_at) } : {}),
    baseChangeIds: json(r.base_change_ids),
    ...(r.root_change_id ? { rootChangeId: String(r.root_change_id) } : {}),
    headChangeIds: json(r.head_change_ids),
    conflictRetained: !!r.conflict_retained,
    rootSessionId: String(r.root_session_id),
    quarantined: !!r.quarantined,
    attention: !!r.attention,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    ...(r.incident_stage
      ? { incident: { stage: String(r.incident_stage), reason: String(r.incident_reason) } }
      : {}),
  };
}
export class SqliteWorkspaceCustody implements WorkspaceCustodyPort {
  constructor(private readonly db: DatabaseSync) {}
  async list(f?: {
    rootSessionId?: string;
    repoId?: string;
    dispositions?: readonly CustodyRecord["disposition"][];
  }): Promise<CustodyRecord[]> {
    const where: string[] = [];
    const args: (string | number | null)[] = [];
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
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = await this.get(m.workspaceId);
      if (!old) throw new Error("Unknown custody row");
      const to = m.disposition ?? old.disposition;
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
      const result = this.db
        .prepare(
          "UPDATE workspace SET disposition=?,updated_at=?,pending_op_id=NULL WHERE id=? AND root_session_id=?",
        )
        .run(to, m.now, m.workspaceId, m.ownRootSessionId);
      if (result.changes !== 1) throw new Error("Custody mutation refused: foreign root");
      this.db
        .prepare(
          "UPDATE custody_operation SET state='committed',settled_at=?,heartbeat_at=? WHERE op_id=?",
        )
        .run(m.now, m.now, opId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return (await this.get(m.workspaceId))!;
  }
  async fail(opId: string, evidence: string) {
    this.db
      .prepare(
        "UPDATE custody_operation SET state='failed',settled_at=datetime('now'),evidence=? WHERE op_id=?",
      )
      .run(evidence.slice(0, 8192), opId);
  }
  async recordAbandonReceipt(
    opId: string,
    r: Parameters<WorkspaceCustodyPort["recordAbandonReceipt"]>[1],
  ) {
    this.db
      .prepare("INSERT INTO abandon_receipt VALUES(?,?,?,?,?,?,?,1,?)")
      .run(
        r.receiptId,
        r.workspaceId,
        opId,
        r.requestedBy,
        JSON.stringify([...r.changeIds].sort()),
        r.jjOpBefore,
        r.jjOpAfter,
        r.at,
      );
  }
  async openOperations(f?: { repoId?: string }) {
    return this.db
      .prepare(
        `SELECT op_id AS opId,workspace_id AS workspaceId,repo_id AS repoId,kind,state,requested_by AS requestedBy,pid,process_identity AS processIdentity,started_at AS now FROM custody_operation WHERE state IN('intent','jj_applied','unknown')${f?.repoId ? " AND repo_id=?" : ""}`,
      )
      .all(...(f?.repoId ? [f.repoId] : [])) as unknown as CustodyOperation[];
  }
  async heartbeat(opId: string) {
    this.db
      .prepare("UPDATE custody_operation SET heartbeat_at=datetime('now') WHERE op_id=?")
      .run(opId);
  }
}
