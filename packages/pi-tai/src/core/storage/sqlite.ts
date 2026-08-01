import { chmodSync, existsSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DurableRecordStore, DurableRecordSummary, RecordCounts } from "../durable/port.ts";
import type { LifecycleRecord } from "../subagents/lifecycle.ts";
import { ensurePrivateDirectory, type StoragePaths } from "./paths.ts";

export const SCHEMA_VERSION = 1;
export const SCHEMA_SQL = `
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE pi_session(session_id TEXT PRIMARY KEY, session_file TEXT, parent_session_id TEXT REFERENCES pi_session(session_id), origin TEXT NOT NULL CHECK(origin IN ('startup','new','resume','fork','unknown')), cwd TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
CREATE TABLE workspace(id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, repo_root TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('active','merged','discarded','incident')), attachment TEXT NOT NULL CHECK(attachment IN ('pending','present','detached')), base_change_ids TEXT NOT NULL, root_change_id TEXT NOT NULL, owner_id TEXT, owner_display_id TEXT, root_session_id TEXT NOT NULL REFERENCES pi_session(session_id), parent_workspace_id TEXT REFERENCES workspace(id), quarantined INTEGER NOT NULL DEFAULT 0 CHECK(quarantined IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, incident_stage TEXT, incident_reason TEXT, merge_json TEXT, UNIQUE(repo_root,name), CHECK((phase='incident')=(incident_stage IS NOT NULL)));
CREATE TABLE subagent(durable_id TEXT PRIMARY KEY, owner_session_id TEXT NOT NULL REFERENCES pi_session(session_id), anchor_token TEXT NOT NULL UNIQUE, anchor_entry_id TEXT, display_seq INTEGER NOT NULL CHECK(display_seq>0), display_id TEXT NOT NULL, backend TEXT NOT NULL CHECK(backend IN ('pi','claude','codex')), capability TEXT, title TEXT NOT NULL CHECK(length(title)<=512), cwd TEXT NOT NULL, workspace_id TEXT REFERENCES workspace(id), audience TEXT NOT NULL DEFAULT 'user' CHECK(audience IN ('user','parent','both')), disposition TEXT NOT NULL CHECK(disposition IN ('spawning','running','done','failed','cancelled','interrupted')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT, archived_by TEXT CHECK(archived_by IN ('user','auto_done')), imported_from TEXT CHECK(imported_from IN ('pi_entries_v1','pi_entries_v2','artifact_scan')), UNIQUE(owner_session_id,display_seq), CHECK((archived_at IS NULL)=(archived_by IS NULL)));
CREATE TABLE subagent_run(run_id TEXT PRIMARY KEY, durable_id TEXT NOT NULL REFERENCES subagent(durable_id) ON DELETE CASCADE, generation INTEGER NOT NULL CHECK(generation>=1), terminal_ordinal INTEGER NOT NULL CHECK(terminal_ordinal>=0), disposition TEXT NOT NULL CHECK(disposition IN ('intent','running','done','failed','interrupted','interrupted_by_reload','orphaned','abandoned')), error_text TEXT CHECK(error_text IS NULL OR length(error_text)<=4096), started_at TEXT NOT NULL, settled_at TEXT, UNIQUE(durable_id,generation,terminal_ordinal), CHECK((settled_at IS NULL)=(disposition IN ('intent','running'))));
CREATE TABLE artifact(artifact_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('report','charter','image','rendition')), owner_session_id TEXT NOT NULL REFERENCES pi_session(session_id), rel_path TEXT NOT NULL CHECK(rel_path NOT GLOB '*..*' AND rel_path NOT LIKE '/%'), original_bytes INTEGER NOT NULL CHECK(original_bytes>=0), stored_bytes INTEGER NOT NULL CHECK(stored_bytes>=0), digest TEXT NOT NULL CHECK(digest GLOB 'sha256:*'), stored_digest TEXT NOT NULL CHECK(stored_digest GLOB 'sha256:*'), truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0,1)), state TEXT NOT NULL CHECK(state IN ('present','evicted','corrupt','unreadable')), created_at TEXT NOT NULL, UNIQUE(owner_session_id,rel_path), CHECK(truncated=0 OR kind='report'), CHECK(truncated=1 OR digest=stored_digest));
CREATE TABLE lock(name TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, process_identity TEXT NOT NULL, acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE quarantine(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('pi_entry','workspaces_json','artifact_scan','transition','schema','legacy_copy')), reason TEXT NOT NULL, evidence TEXT NOT NULL CHECK(length(evidence)<=8192));
CREATE INDEX idx_subagent_owner ON subagent(owner_session_id,archived_at);
CREATE INDEX idx_subagent_anchor ON subagent(anchor_token);
CREATE INDEX idx_run_durable ON subagent_run(durable_id,generation,terminal_ordinal);
CREATE INDEX idx_workspace_root ON workspace(root_session_id,phase);
`;

export interface OpenSqliteOptions {
  paths: StoragePaths;
  now?: () => Date;
  memory?: boolean;
}

export function openDurableDatabase(options: OpenSqliteOptions): DatabaseSync {
  const now = options.now ?? (() => new Date());
  ensurePrivateDirectory(options.paths.state);
  let db: DatabaseSync;
  const target = options.memory ? ":memory:" : options.paths.database;
  try {
    db = new DatabaseSync(target);
    const check = db.prepare("PRAGMA quick_check").get() as { quick_check: string };
    if (check.quick_check !== "ok") throw new Error(`quick_check: ${check.quick_check}`);
  } catch (error) {
    if (options.memory || !existsSync(target)) throw error;
    ensurePrivateDirectory(options.paths.quarantine);
    const stamp = now().toISOString().replaceAll(":", "-");
    renameSync(target, join(options.paths.quarantine, `state-${stamp}.corrupt`));
    db = new DatabaseSync(target);
  }
  const mode = db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode: string };
  db.exec(
    `PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;`,
  );
  if (!options.memory && mode.journal_mode.toLowerCase() !== "wal")
    db.exec("PRAGMA busy_timeout=15000");
  const version = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
  );
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new Error(`Database schema ${version} is newer than supported schema ${SCHEMA_VERSION}`);
  }
  if (version === 0) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(SCHEMA_SQL);
      db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)").run(
        SCHEMA_VERSION,
        now().toISOString(),
      );
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}; COMMIT`);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (!options.memory) chmodSync(target, 0o600);
  return db;
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
    const seq = Number(summary.displayId.match(/\d+/)?.[0] ?? 1);
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
  }
  get(id: string): DurableRecordSummary | undefined {
    const row = this.db
      .prepare(
        "SELECT durable_id,display_id,owner_session_id,disposition,archived_at,archived_by,updated_at FROM subagent WHERE durable_id=?",
      )
      .get(id) as Record<string, string | null> | undefined;
    return row
      ? {
          durableId: row.durable_id!,
          displayId: row.display_id!,
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
