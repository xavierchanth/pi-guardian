import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DurableRecordStore, DurableRecordSummary, RecordCounts } from "../durable/port.ts";
import type { LifecycleRecord } from "../subagents/lifecycle.ts";
import { ensurePrivateDirectory, type StoragePaths } from "./paths.ts";

export const SCHEMA_VERSION = 2;
export const SCHEMA_SQL_V1 = `
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE pi_session(session_id TEXT PRIMARY KEY, session_file TEXT, parent_session_id TEXT REFERENCES pi_session(session_id), origin TEXT NOT NULL CHECK(origin IN ('startup','new','resume','fork','unknown')), cwd TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
CREATE TABLE workspace(id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, repo_root TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('active','merged','discarded','incident')), attachment TEXT NOT NULL CHECK(attachment IN ('pending','present','detached')), base_change_ids TEXT NOT NULL, root_change_id TEXT NOT NULL, owner_id TEXT, owner_display_id TEXT, root_session_id TEXT NOT NULL REFERENCES pi_session(session_id), parent_workspace_id TEXT REFERENCES workspace(id), quarantined INTEGER NOT NULL DEFAULT 0 CHECK(quarantined IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, incident_stage TEXT, incident_reason TEXT, merge_json TEXT, UNIQUE(repo_root,name), CHECK((phase='incident')=(incident_stage IS NOT NULL)));
CREATE TABLE subagent(durable_id TEXT PRIMARY KEY, owner_session_id TEXT NOT NULL REFERENCES pi_session(session_id), anchor_token TEXT NOT NULL UNIQUE, anchor_entry_id TEXT, display_seq INTEGER NOT NULL CHECK(display_seq>0), display_id TEXT NOT NULL, backend TEXT NOT NULL CHECK(backend IN ('pi','claude','codex')), capability TEXT, title TEXT NOT NULL CHECK(length(title)<=512), cwd TEXT NOT NULL, workspace_id TEXT REFERENCES workspace(id), audience TEXT NOT NULL DEFAULT 'user' CHECK(audience IN ('user','parent','both')), disposition TEXT NOT NULL CHECK(disposition IN ('intent','spawning','running','done','failed','cancelled','interrupted')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT, archived_by TEXT CHECK(archived_by IN ('user','auto_done')), imported_from TEXT CHECK(imported_from IN ('pi_entries_v1','pi_entries_v2','artifact_scan')), UNIQUE(owner_session_id,display_seq), CHECK((archived_at IS NULL)=(archived_by IS NULL)));
CREATE TABLE subagent_run(run_id TEXT PRIMARY KEY, durable_id TEXT NOT NULL REFERENCES subagent(durable_id) ON DELETE CASCADE, generation INTEGER NOT NULL CHECK(generation>=1), terminal_ordinal INTEGER NOT NULL CHECK(terminal_ordinal>=0), disposition TEXT NOT NULL CHECK(disposition IN ('intent','running','done','failed','interrupted','interrupted_by_reload','orphaned','abandoned')), error_text TEXT CHECK(error_text IS NULL OR length(error_text)<=4096), started_at TEXT NOT NULL, settled_at TEXT, UNIQUE(durable_id,generation,terminal_ordinal), CHECK((settled_at IS NULL)=(disposition IN ('intent','running'))));
CREATE TABLE artifact(artifact_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('report','charter','image','rendition')), owner_session_id TEXT NOT NULL REFERENCES pi_session(session_id), rel_path TEXT NOT NULL CHECK(rel_path NOT GLOB '*..*' AND rel_path NOT LIKE '/%'), original_bytes INTEGER NOT NULL CHECK(original_bytes>=0), stored_bytes INTEGER NOT NULL CHECK(stored_bytes>=0), digest TEXT NOT NULL CHECK(digest GLOB 'sha256:*'), stored_digest TEXT NOT NULL CHECK(stored_digest GLOB 'sha256:*'), truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0,1)), state TEXT NOT NULL CHECK(state IN ('present','evicted','corrupt','unreadable')), created_at TEXT NOT NULL, UNIQUE(owner_session_id,rel_path), CHECK(truncated=0 OR kind='report'), CHECK(truncated=1 OR digest=stored_digest));
CREATE TABLE lock(name TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, process_identity TEXT NOT NULL, acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE quarantine(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('pi_entry','workspaces_json','artifact_scan','transition','schema','legacy_copy')), reason TEXT NOT NULL, evidence TEXT NOT NULL CHECK(length(evidence)<=8192));
CREATE INDEX idx_subagent_owner ON subagent(owner_session_id,archived_at);
CREATE INDEX idx_subagent_anchor ON subagent(anchor_token);
CREATE INDEX idx_run_durable ON subagent_run(durable_id,generation,terminal_ordinal);
CREATE INDEX idx_workspace_root ON workspace(root_session_id,phase);
`;

export const SCHEMA_SQL_V2 = `
CREATE TABLE repository(repo_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL UNIQUE,roots_truncated INTEGER NOT NULL DEFAULT 0 CHECK(roots_truncated IN(0,1)),store_key TEXT,last_known_root TEXT NOT NULL,identity_proven INTEGER NOT NULL DEFAULT 1 CHECK(identity_proven IN(0,1)),first_seen_at TEXT NOT NULL,last_verified_at TEXT NOT NULL);
INSERT INTO repository VALUES('repo_unresolved','{"v":1,"roots":[]}',0,NULL,'',0,'1970-01-01T00:00:00.000Z','1970-01-01T00:00:00.000Z');
CREATE TABLE custody_operation(op_id TEXT PRIMARY KEY,workspace_id TEXT,repo_id TEXT REFERENCES repository(repo_id),kind TEXT NOT NULL CHECK(kind IN('create','assign_owner','merge','finalize_merge','forget','abandon','adopt','rebind_repo','reconcile','import','resolve_incident')),state TEXT NOT NULL CHECK(state IN('intent','jj_applied','committed','failed','unknown')),requested_by TEXT NOT NULL CHECK(requested_by IN('user','model_tool','system_spawn','system_settle','system_reconcile','system_migration','scaffold_reclaim')),pid INTEGER NOT NULL,process_identity TEXT NOT NULL,jj_op_before TEXT,jj_op_after TEXT,target_change_id TEXT,change_ids TEXT,started_at TEXT NOT NULL,heartbeat_at TEXT NOT NULL,settled_at TEXT,evidence TEXT CHECK(evidence IS NULL OR length(evidence)<=8192),CHECK((settled_at IS NULL)=(state IN('intent','jj_applied'))));
CREATE TABLE custody_event(op_id TEXT NOT NULL REFERENCES custody_operation(op_id) ON DELETE CASCADE,seq INTEGER NOT NULL,workspace_id TEXT,from_disposition TEXT,to_disposition TEXT NOT NULL,cause TEXT NOT NULL CHECK(cause IN('create','attach_proved','forget','merge_proved','merge_conflicts_retained','abandon_receipted','evidence_missing','ambiguity','incident_resolved','import','adopt','repo_rebound','heads_refreshed')),at TEXT NOT NULL,PRIMARY KEY(op_id,seq));
CREATE TABLE abandon_receipt(receipt_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,op_id TEXT NOT NULL REFERENCES custody_operation(op_id),requested_by TEXT NOT NULL CHECK(requested_by IN('user','model_tool','scaffold_reclaim')),change_ids TEXT NOT NULL,jj_op_before TEXT NOT NULL,jj_op_after TEXT NOT NULL,verified_absent INTEGER NOT NULL CHECK(verified_absent IN(0,1)),at TEXT NOT NULL,UNIQUE(workspace_id,op_id));
CREATE TABLE allowed_custody_transition(from_disposition TEXT NOT NULL,to_disposition TEXT NOT NULL,cause TEXT NOT NULL,PRIMARY KEY(from_disposition,to_disposition,cause));
INSERT INTO allowed_custody_transition VALUES
('merged','merged','heads_refreshed'),('abandoned','abandoned','heads_refreshed'),('missing','missing','heads_refreshed'),('incident','incident','heads_refreshed'),('attached','attached','heads_refreshed'),('attached','detached','forget'),('attached','detached','evidence_missing'),('attached','merged','merge_proved'),('attached','attached','merge_conflicts_retained'),('attached','abandoned','abandon_receipted'),('attached','missing','evidence_missing'),('attached','incident','ambiguity'),('detached','attached','attach_proved'),('detached','detached','heads_refreshed'),('detached','merged','merge_proved'),('detached','abandoned','abandon_receipted'),('detached','missing','evidence_missing'),('detached','incident','ambiguity'),('missing','attached','attach_proved'),('missing','detached','attach_proved'),('missing','merged','merge_proved'),('missing','abandoned','abandon_receipted'),('missing','incident','ambiguity'),('merged','incident','ambiguity'),('abandoned','incident','ambiguity'),('incident','attached','incident_resolved'),('incident','detached','incident_resolved'),('incident','merged','incident_resolved'),('incident','abandoned','incident_resolved'),('incident','missing','incident_resolved'),('incident','incident','ambiguity');
CREATE TABLE workspace_v2(id TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT NOT NULL,repo_id TEXT NOT NULL REFERENCES repository(repo_id),repo_root TEXT NOT NULL,disposition TEXT NOT NULL CHECK(disposition IN('attached','detached','merged','abandoned','missing','incident')),attachment_evidence TEXT NOT NULL DEFAULT 'unknown' CHECK(attachment_evidence IN('present','absent','unknown')),directory_evidence TEXT NOT NULL DEFAULT 'unknown' CHECK(directory_evidence IN('present','absent','unknown')),evidence_at TEXT,base_change_ids TEXT NOT NULL,root_change_id TEXT,head_change_ids TEXT NOT NULL DEFAULT '[]',merged_into_change_id TEXT,merged_proof_op TEXT,conflict_retained INTEGER NOT NULL DEFAULT 0 CHECK(conflict_retained IN(0,1)),owner_id TEXT,owner_display_id TEXT,anchor_token TEXT CHECK(anchor_token IS NULL OR anchor_token GLOB 'atk_*'),root_session_id TEXT NOT NULL REFERENCES pi_session(session_id),parent_workspace_id TEXT REFERENCES workspace_v2(id),pending_op_id TEXT REFERENCES custody_operation(op_id),quarantined INTEGER NOT NULL DEFAULT 0 CHECK(quarantined IN(0,1)),attention INTEGER NOT NULL DEFAULT 0 CHECK(attention IN(0,1)),imported_from TEXT CHECK(imported_from IN('workspaces_json_v2','workspaces_json_v1','adopted_attachment')),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,incident_stage TEXT,incident_reason TEXT,merge_json TEXT,UNIQUE(repo_id,name),CHECK((disposition='incident')=(incident_stage IS NOT NULL)),CHECK((disposition='incident')=(incident_reason IS NOT NULL)),CHECK(disposition<>'merged' OR (merged_into_change_id IS NOT NULL AND merged_proof_op IS NOT NULL)),CHECK(root_change_id IS NOT NULL OR pending_op_id IS NOT NULL));
INSERT INTO workspace_v2(id,name,path,repo_id,repo_root,disposition,attachment_evidence,base_change_ids,root_change_id,head_change_ids,owner_id,owner_display_id,root_session_id,parent_workspace_id,quarantined,created_at,updated_at,incident_stage,incident_reason,merge_json) SELECT id,name,path,'repo_unresolved',repo_root,CASE WHEN quarantined=1 OR phase IN('incident','merged','discarded') THEN 'incident' WHEN attachment='present' THEN 'attached' ELSE 'detached' END,CASE attachment WHEN 'present' THEN 'present' WHEN 'detached' THEN 'absent' ELSE 'unknown' END,base_change_ids,root_change_id,json_array(root_change_id),owner_id,owner_display_id,root_session_id,parent_workspace_id,quarantined,created_at,updated_at,COALESCE(incident_stage,CASE WHEN phase IN('merged','discarded') OR quarantined=1 THEN 'schema_v2_migration' END),COALESCE(incident_reason,CASE phase WHEN 'merged' THEN 'legacy_merged_without_proof' WHEN 'discarded' THEN 'legacy_discarded_without_receipt' ELSE CASE WHEN quarantined=1 THEN 'legacy_quarantined_record' END END),merge_json FROM workspace;
DROP TABLE workspace; ALTER TABLE workspace_v2 RENAME TO workspace;
CREATE INDEX idx_workspace_repo ON workspace(repo_id,disposition); CREATE INDEX idx_workspace_root_disposition ON workspace(root_session_id,disposition); CREATE INDEX idx_workspace_owner ON workspace(owner_id) WHERE owner_id IS NOT NULL; CREATE INDEX idx_workspace_open ON workspace(disposition) WHERE disposition IN('attached','detached','incident','missing'); CREATE INDEX idx_custody_op_live ON custody_operation(state) WHERE state IN('intent','jj_applied','unknown');
CREATE TRIGGER trg_workspace_transition BEFORE UPDATE OF disposition ON workspace BEGIN SELECT RAISE(ABORT,'illegal custody transition') WHERE NOT EXISTS(SELECT 1 FROM custody_event latest JOIN allowed_custody_transition t ON t.from_disposition=OLD.disposition AND t.to_disposition=NEW.disposition AND t.cause=latest.cause WHERE latest.workspace_id=NEW.id AND latest.rowid=(SELECT MAX(e.rowid) FROM custody_event e WHERE e.workspace_id=NEW.id)); END;
CREATE TRIGGER trg_abandon_requires_receipt_update BEFORE UPDATE OF disposition ON workspace WHEN NEW.disposition='abandoned' AND NOT EXISTS(SELECT 1 FROM abandon_receipt r WHERE r.workspace_id=NEW.id AND r.verified_absent=1 AND r.change_ids=NEW.head_change_ids) BEGIN SELECT RAISE(ABORT,'abandoned requires a verified abandon receipt'); END;
CREATE TRIGGER trg_abandon_requires_receipt_insert BEFORE INSERT ON workspace WHEN NEW.disposition='abandoned' AND NOT EXISTS(SELECT 1 FROM abandon_receipt r WHERE r.workspace_id=NEW.id AND r.verified_absent=1 AND r.change_ids=NEW.head_change_ids) BEGIN SELECT RAISE(ABORT,'abandoned requires a verified abandon receipt'); END;
CREATE TRIGGER trg_no_reconcile_abandon BEFORE INSERT ON abandon_receipt WHEN (SELECT requested_by FROM custody_operation WHERE op_id=NEW.op_id) IN('system_reconcile','system_migration','system_spawn','system_settle') BEGIN SELECT RAISE(ABORT,'reconciliation may never abandon'); END;
CREATE TRIGGER trg_no_workspace_delete BEFORE DELETE ON workspace BEGIN SELECT RAISE(ABORT,'custody rows are never deleted in S1'); END;
`;
export const MIGRATIONS = [
  { version: 1, sql: SCHEMA_SQL_V1 },
  { version: 2, sql: SCHEMA_SQL_V2 },
] as const;
/** Complete current schema, retained for schema-golden callers. */
export const SCHEMA_SQL = SCHEMA_SQL_V1 + SCHEMA_SQL_V2;

export interface OpenSqliteOptions {
  paths: StoragePaths;
  now?: () => Date;
  memory?: boolean;
}

function privatize(paths: StoragePaths): void {
  for (const path of [paths.database, `${paths.database}-wal`, `${paths.database}-shm`])
    if (existsSync(path)) chmodSync(path, 0o600);
}

function quarantineDatabase(paths: StoragePaths, stamp: string): void {
  ensurePrivateDirectory(paths.quarantine);
  const evidence = join(paths.quarantine, `state-${stamp}.corrupt`);
  mkdirSync(evidence, { mode: 0o700 });
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${paths.database}${suffix}`;
    if (existsSync(source)) renameSync(source, join(evidence, `state.sqlite${suffix}`));
  }
}

export function openDurableDatabase(options: OpenSqliteOptions): DatabaseSync {
  const now = options.now ?? (() => new Date());
  ensurePrivateDirectory(options.paths.state);
  let db: DatabaseSync | undefined;
  const target = options.memory ? ":memory:" : options.paths.database;
  try {
    db = new DatabaseSync(target);
    if (!options.memory) privatize(options.paths);
    const check = db.prepare("PRAGMA quick_check").get() as { quick_check: string };
    if (check.quick_check !== "ok") throw new Error(`quick_check: ${check.quick_check}`);
  } catch (error) {
    try {
      db?.close();
    } catch {}
    if (options.memory || !existsSync(target)) throw error;
    quarantineDatabase(options.paths, now().toISOString().replaceAll(":", "-"));
    db = new DatabaseSync(target);
    privatize(options.paths);
  }
  db.exec("PRAGMA busy_timeout=15000");
  const initial = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
  );
  if (initial > SCHEMA_VERSION) {
    db.close();
    throw new Error(`Database schema ${initial} is newer than supported schema ${SCHEMA_VERSION}`);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    // A competing cold opener may have completed while this connection waited for the lock.
    const version = Number(
      (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    );
    if (version > SCHEMA_VERSION)
      throw new Error(
        `Database schema ${version} is newer than supported schema ${SCHEMA_VERSION}`,
      );
    if (version > 0) {
      const migration = db
        .prepare("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations")
        .get() as { version: number };
      if (Number(migration.version) !== version)
        throw new Error(
          `Schema authorities disagree: user_version=${version}, migration=${migration.version}`,
        );
    }
    for (const migration of MIGRATIONS)
      if (migration.version > version) {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)").run(
          migration.version,
          now().toISOString(),
        );
      }
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length)
      throw new Error(`Foreign key check failed (${violations.length} violations)`);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    db.close();
    throw error;
  }
  const mode = db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode: string };
  db.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF");
  if (!options.memory && mode.journal_mode.toLowerCase() !== "wal")
    db.exec("PRAGMA busy_timeout=15000");
  if (!options.memory) privatize(options.paths);
  return db;
}

function privatizeConnection(db: DatabaseSync): void {
  const row = db
    .prepare("PRAGMA database_list")
    .all()
    .find((item) => (item as { name: string }).name === "main") as { file: string } | undefined;
  if (!row?.file) return;
  for (const path of [row.file, `${row.file}-wal`, `${row.file}-shm`])
    if (existsSync(path)) chmodSync(path, 0o600);
}

export class SqliteDurableRecordStore implements DurableRecordStore {
  private readonly db: DatabaseSync;
  private readonly rootSessionId: string;
  constructor(db: DatabaseSync, rootSessionId: string) {
    this.db = db;
    this.rootSessionId = rootSessionId;
  }
  ingest(records: Iterable<LifecycleRecord>): void {
    for (const record of records) this.note(record);
  }
  note(summary: DurableRecordSummary, authoritative = false): void {
    const root = summary.rootSessionId ?? this.rootSessionId;
    const now = summary.updatedAt;
    this.db
      .prepare(
        "INSERT OR IGNORE INTO pi_session(session_id,origin,cwd,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)",
      )
      .run(root, "unknown", "", now, now);
    const seq = summary.sequence;
    this.db
      .prepare(`INSERT INTO subagent(durable_id,owner_session_id,anchor_token,display_seq,display_id,backend,title,cwd,disposition,created_at,updated_at,archived_at,archived_by)
      VALUES(?,?,?,?,?,'pi','imported','',?,?,?,?,?) ON CONFLICT(durable_id) DO UPDATE SET disposition=excluded.disposition,updated_at=excluded.updated_at,archived_at=excluded.archived_at,archived_by=excluded.archived_by
      WHERE ${authoritative ? "subagent.updated_at <= excluded.updated_at" : "subagent.updated_at < excluded.updated_at"}`)
      .run(
        summary.durableId,
        root,
        `atk_${summary.durableId}`,
        seq,
        summary.displayId,
        summary.disposition,
        now,
        now,
        summary.archivedAt ?? null,
        summary.archivedBy ?? null,
      );
    privatizeConnection(this.db);
  }
  get(id: string): DurableRecordSummary | undefined {
    const row = this.db
      .prepare(
        "SELECT durable_id,display_seq,display_id,owner_session_id,disposition,archived_at,archived_by,updated_at FROM subagent WHERE durable_id=?",
      )
      .get(id) as Record<string, string | null> | undefined;
    return row
      ? {
          durableId: row.durable_id!,
          displayId: row.display_id!,
          sequence: Number(row.display_seq),
          rootSessionId: row.owner_session_id!,
          disposition: row.disposition as DurableRecordSummary["disposition"],
          updatedAt: row.updated_at!,
          ...(row.archived_at
            ? { archivedAt: row.archived_at, archivedBy: row.archived_by as "user" | "auto_done" }
            : {}),
        }
      : undefined;
  }
  isInherited(id: string): boolean {
    const row = this.get(id);
    return !!row?.rootSessionId && row.rootSessionId !== this.rootSessionId;
  }
  counts(): RecordCounts {
    const rows = this.db.prepare("SELECT owner_session_id,archived_at FROM subagent").all() as {
      owner_session_id: string;
      archived_at: string | null;
    }[];
    let unarchived = 0,
      archived = 0,
      inherited = 0;
    for (const row of rows)
      row.owner_session_id !== this.rootSessionId
        ? inherited++
        : row.archived_at
          ? archived++
          : unarchived++;
    return { unarchived, archived, inherited, total: rows.length };
  }
}

export function backupDatabase(db: DatabaseSync, paths: StoragePaths, name: string): string {
  ensurePrivateDirectory(paths.backups);
  const destination = join(paths.backups, basename(name));
  db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
  chmodSync(destination, 0o600);
  return destination;
}
