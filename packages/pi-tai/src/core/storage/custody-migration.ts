import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ensurePrivateDirectory, type StoragePaths } from "./paths.ts";

const CHANGE_ID = /^[k-z]{4,64}$/;
const sleep = (milliseconds: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

function quarantine(db: DatabaseSync, now: Date, reason: string, evidence: unknown): void {
  db.prepare(
    "INSERT INTO quarantine(at,source,reason,evidence) VALUES(?,'workspaces_json',?,?)",
  ).run(now.toISOString(), reason, JSON.stringify(evidence).slice(0, 8192));
}

function validate(
  bytes: Buffer,
): { records: Record<string, unknown>[] } | { reason: string; detail: string } {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    return { reason: "malformed_json", detail: String(error) };
  }
  if (!Array.isArray(value)) return { reason: "invalid_top_level", detail: "expected an array" };
  const records: Record<string, unknown>[] = [];
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return { reason: "invalid_record", detail: `record ${index} is not an object` };
    const r = raw as Record<string, unknown>;
    for (const key of ["id", "name", "path", "repoRoot", "rootSessionId", "rootChangeId"])
      if (typeof r[key] !== "string" || !(r[key] as string).trim())
        return { reason: `missing_${key}`, detail: `record ${index}` };
    if (r.version !== 2) return { reason: "unsupported_version", detail: `record ${index}` };
    if (!Array.isArray(r.baseChangeIds) || r.baseChangeIds.length === 0)
      return { reason: "empty_bases", detail: `record ${index}` };
    const ids = [...r.baseChangeIds, r.rootChangeId];
    if (ids.some((id) => typeof id !== "string" || !CHANGE_ID.test(id)))
      return { reason: "invalid_change_id", detail: `record ${index}` };
    if (
      !resolve(r.repoRoot as string).startsWith("/") ||
      resolve(r.repoRoot as string) !== r.repoRoot
    )
      return { reason: "invalid_repo_root", detail: `record ${index}` };
    records.push(r);
  }
  return { records };
}

/** Explicit, non-startup migration. Invalid input is quarantined but is never renamed or retired. */
export function migrateWorkspaceRegistry(
  db: DatabaseSync,
  agentDir: string,
  paths: StoragePaths,
  now = new Date(),
): string | undefined {
  const source = join(agentDir, "pi-tai", "agents", "workspaces.json");
  if (!existsSync(source)) return undefined;
  ensurePrivateDirectory(paths.migration);
  const lock = join(paths.migration, ".custody-migration.lock");
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline)
        throw new Error("Timed out acquiring custody migration operation lock");
      sleep(20);
    }
  }
  try {
    if (!existsSync(source)) return undefined; // another process completed while we waited
    const bytes = readFileSync(source);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const prior = db
      .prepare(
        "SELECT evidence FROM quarantine WHERE source='workspaces_json' AND reason='migration_completed' AND evidence LIKE ?",
      )
      .get(`%${digest}%`);
    if (prior) return undefined;
    const parsed = validate(bytes);
    if ("reason" in parsed) {
      quarantine(db, now, parsed.reason, { source, sha256: digest, detail: parsed.detail });
      return undefined;
    }
    const copy = join(paths.migration, `workspaces-${digest}.json`);
    if (!existsSync(copy)) {
      const temporary = `${copy}.${process.pid}.tmp`;
      copyFileSync(source, temporary);
      chmodSync(temporary, 0o600);
      if (createHash("sha256").update(readFileSync(temporary)).digest("hex") !== digest)
        throw new Error("workspaces.json verified-copy digest mismatch");
      try {
        renameSync(temporary, copy);
      } catch (error: any) {
        rmSync(temporary, { force: true });
        if (error?.code !== "EEXIST") throw error;
      }
    }
    const adopted: string[] = [];
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const r of parsed.records) {
        db.prepare(
          "INSERT OR IGNORE INTO pi_session(session_id,origin,cwd,first_seen_at,last_seen_at) VALUES(?,'unknown','',?,?)",
        ).run(String(r.rootSessionId), now.toISOString(), now.toISOString());
        const result = db
          .prepare(
            "INSERT OR IGNORE INTO workspace(id,name,path,repo_id,repo_root,disposition,attachment_evidence,base_change_ids,root_change_id,head_change_ids,root_session_id,quarantined,attention,imported_from,created_at,updated_at,incident_stage,incident_reason) VALUES(?,?,?,?,?,'incident','unknown',?,?,?,?,0,1,'workspaces_json_v2',?,?, 'custody_migration','legacy_requires_repository_proof')",
          )
          .run(
            String(r.id),
            String(r.name),
            String(r.path),
            "repo_unresolved",
            String(r.repoRoot),
            JSON.stringify(r.baseChangeIds),
            String(r.rootChangeId),
            JSON.stringify([r.rootChangeId]),
            String(r.rootSessionId),
            String(r.createdAt ?? now.toISOString()),
            String(r.updatedAt ?? now.toISOString()),
          );
        if (result.changes) adopted.push(String(r.id));
      }
      quarantine(db, now, "migration_completed", { source, sha256: digest, adopted });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const receipt = join(paths.migration, `${digest}-custody.json`);
    if (!existsSync(receipt))
      writeFileSync(
        receipt,
        JSON.stringify({
          version: 1,
          legacyFile: source,
          copyPath: copy,
          sha256: digest,
          adopted,
          completedAt: now.toISOString(),
        }),
        { mode: 0o600, flag: "wx" },
      );
    // Retirement is last: source remains intact for every parse/constraint/commit failure.
    const retired = join(dirname(source), `workspaces.json.migrated-${digest}`);
    if (existsSync(source) && !existsSync(retired)) renameSync(source, retired);
    return receipt;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
