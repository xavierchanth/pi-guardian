import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ensurePrivateDirectory, type StoragePaths } from "./paths.ts";

/** Non-destructive M1 import. This prepares SQLite authority but is deliberately not on startup yet. */
export function migrateWorkspaceRegistry(
  db: DatabaseSync,
  agentDir: string,
  paths: StoragePaths,
  now = new Date(),
): string | undefined {
  const source = join(agentDir, "pi-tai", "agents", "workspaces.json");
  if (!existsSync(source)) return undefined;
  ensurePrivateDirectory(paths.migration);
  const siblings = readdirSync(dirname(source));
  const stamp = now.toISOString().replaceAll(":", "-");
  const bytes = readFileSync(source);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (siblings.some((n) => n.startsWith("workspaces.json.migrated-"))) {
    const foreign = join(paths.migration, `foreign-${stamp}.json`);
    copyFileSync(source, foreign);
    chmodSync(foreign, 0o600);
    db.prepare(
      "INSERT INTO quarantine(at,source,reason,evidence) VALUES(?, 'workspaces_json','foreign_reappearance',?)",
    ).run(now.toISOString(), JSON.stringify({ source, foreign, digest }).slice(0, 8192));
    return foreign;
  }
  if (readdirSync(paths.migration).some((n) => n.endsWith("-custody.json"))) return undefined;
  const copy = join(paths.migration, `workspaces-${stamp}.json`);
  const temporary = `${copy}.tmp`;
  copyFileSync(source, temporary);
  chmodSync(temporary, 0o600);
  if (createHash("sha256").update(readFileSync(temporary)).digest("hex") !== digest)
    throw new Error("workspaces.json verified-copy digest mismatch");
  renameSync(temporary, copy);
  let records: unknown;
  try {
    records = JSON.parse(bytes.toString("utf8"));
  } catch {
    records = [];
  }
  const adopted: { id: string; name: string; disposition: string }[] = [];
  const quarantined: { id: string; reason: string }[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [index, raw] of (Array.isArray(records) ? records : [records]).entries()) {
      const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const valid = r.version === 2 && typeof r.rootSessionId === "string";
      const id = typeof r.id === "string" ? r.id : `legacy_${digest.slice(0, 16)}_${index}`;
      const phase = String(r.phase ?? "");
      const disposition = valid && phase === "active" ? "attached" : "incident";
      const reason = !valid
        ? "legacy_v1_unadoptable"
        : phase === "merged"
          ? "legacy_merged_without_proof"
          : phase === "discarded"
            ? "legacy_discarded_without_receipt"
            : phase === "incident"
              ? String(
                  (r.incident as Record<string, unknown> | undefined)?.reason ?? "legacy_incident",
                )
              : undefined;
      const root = valid ? String(r.rootSessionId) : `quarantine_${digest.slice(0, 16)}`;
      db.prepare(
        "INSERT OR IGNORE INTO pi_session(session_id,origin,cwd,first_seen_at,last_seen_at) VALUES(?,'unknown','',?,?)",
      ).run(root, now.toISOString(), now.toISOString());
      const result = db
        .prepare(
          "INSERT OR IGNORE INTO workspace(id,name,path,repo_id,repo_root,disposition,attachment_evidence,base_change_ids,root_change_id,head_change_ids,owner_id,root_session_id,quarantined,attention,imported_from,created_at,updated_at,incident_stage,incident_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          String(r.name ?? `quarantine-${index}`),
          String(r.path ?? ""),
          "repo_unresolved",
          String(r.repoRoot ?? ""),
          disposition,
          "unknown",
          JSON.stringify(r.baseChangeIds ?? []),
          String(r.rootChangeId ?? id),
          JSON.stringify([String(r.rootChangeId ?? id)]),
          valid && typeof r.ownerId === "string" ? r.ownerId : null,
          root,
          valid ? 0 : 1,
          1,
          valid ? "workspaces_json_v2" : "workspaces_json_v1",
          String(r.createdAt ?? now.toISOString()),
          String(r.updatedAt ?? now.toISOString()),
          disposition === "incident" ? "custody_migration" : null,
          disposition === "incident" ? (reason ?? "legacy_ambiguous") : null,
        );
      if (result.changes) adopted.push({ id, name: String(r.name ?? ""), disposition });
      else {
        quarantined.push({ id, reason: "duplicate_repo_name" });
        db.prepare(
          "INSERT INTO quarantine(at,source,reason,evidence) VALUES(?,'workspaces_json','duplicate_repo_name',?)",
        ).run(now.toISOString(), JSON.stringify(raw).slice(0, 8192));
      }
      if (!valid) {
        quarantined.push({ id, reason: "legacy_v1_unadoptable" });
        db.prepare(
          "INSERT INTO quarantine(at,source,reason,evidence) VALUES(?,'workspaces_json','legacy_v1_unadoptable',?)",
        ).run(now.toISOString(), JSON.stringify(raw).slice(0, 8192));
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  const receipt = join(paths.migration, `${stamp}-custody.json`);
  writeFileSync(
    receipt,
    JSON.stringify({
      version: 1,
      legacyFile: source,
      copyPath: copy,
      sha256: digest,
      recordCount: Array.isArray(records) ? records.length : 1,
      adopted,
      quarantined,
      repoRootsUnreachable: [],
      completedAt: now.toISOString(),
    }),
    { mode: 0o600, flag: "wx" },
  );
  try {
    renameSync(source, join(dirname(source), `${basename(source)}.migrated-${stamp}`));
  } catch (error) {
    db.prepare(
      "INSERT INTO quarantine(at,source,reason,evidence) VALUES(?,'workspaces_json','source_rename_failed',?)",
    ).run(now.toISOString(), String(error).slice(0, 8192));
  }
  return receipt;
}
