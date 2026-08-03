import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type ProcessState, processState } from "./operation-lease.ts";
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
  probe: (pid: number) => ProcessState = processState,
): string | undefined {
  const source = join(agentDir, "pi-tai", "agents", "workspaces.json");
  if (!existsSync(source)) return undefined;
  ensurePrivateDirectory(paths.migration);
  const leaseToken = `${process.pid}:${Date.now()}`;
  // A free lease needs no liveness proof. Retain an explicitly unprovable
  // identity so restricted procfs/ps environments can still migrate, while
  // stale-lease stealing below continues to fail closed.
  const self = probe(process.pid);
  const pidStart = self.state === "live" ? self.start : "unprovable";
  const deadline = Date.now() + 15_000;
  while (true) {
    const nowMs = Date.now();
    const prior = db.prepare("SELECT * FROM operation_lease WHERE scope='migration'").get() as any;
    let available = !prior;
    if (prior && Number(prior.expires_at) <= nowMs) {
      const state = probe(Number(prior.pid));
      available =
        state.state === "dead" ||
        (state.state === "live" && state.start !== String(prior.pid_start));
    }
    if (available) {
      const expected = prior ? String(prior.token) : "";
      const result = db
        .prepare(
          "INSERT INTO operation_lease(scope,owner,token,pid,pid_start,heartbeat_at,expires_at) VALUES('migration','system_migration',?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET owner=excluded.owner,token=excluded.token,pid=excluded.pid,pid_start=excluded.pid_start,heartbeat_at=excluded.heartbeat_at,expires_at=excluded.expires_at WHERE operation_lease.token=?",
        )
        .run(leaseToken, process.pid, pidStart, nowMs, nowMs + 30_000, expected);
      if (result.changes) break;
    }
    if (nowMs >= deadline) throw new Error("Timed out acquiring custody migration operation lease");
    sleep(20);
  }
  try {
    if (!existsSync(source)) return undefined; // another process completed while we waited
    const bytes = readFileSync(source);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const prior = db
      .prepare(
        "SELECT 1 FROM migration_ledger WHERE source='workspaces_json' AND digest=? AND state='completed'",
      )
      .get(digest);
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
    const collisions: unknown[] = [];
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const [index, r] of parsed.records.entries()) {
        const repoRoot = String(r.repoRoot);
        const repoId = `legacy_${createHash("sha256").update(repoRoot).digest("hex").slice(0, 32)}`;
        const fingerprint = JSON.stringify({ v: 1, legacyRepoRoot: repoRoot });
        db.prepare(
          "INSERT INTO repository(repo_id,fingerprint,last_known_root,identity_proven,first_seen_at,last_verified_at) VALUES(?,?,?,0,?,?) ON CONFLICT(repo_id) DO UPDATE SET last_known_root=excluded.last_known_root",
        ).run(repoId, fingerprint, repoRoot, now.toISOString(), now.toISOString());
        db.prepare(
          "INSERT INTO pi_session(session_id,origin,cwd,first_seen_at,last_seen_at) VALUES(?,'unknown','',?,?) ON CONFLICT(session_id) DO UPDATE SET last_seen_at=max(last_seen_at,excluded.last_seen_at)",
        ).run(String(r.rootSessionId), now.toISOString(), now.toISOString());
        const result = db
          .prepare(
            "INSERT OR IGNORE INTO workspace(id,name,path,repo_id,repo_root,disposition,attachment_evidence,base_change_ids,root_change_id,head_change_ids,root_session_id,quarantined,attention,imported_from,created_at,updated_at,incident_stage,incident_reason) VALUES(?,?,?,?,?,'incident','unknown',?,?,?,?,0,1,'workspaces_json_v2',?,?, 'custody_migration','legacy_requires_repository_proof')",
          )
          .run(
            String(r.id),
            String(r.name),
            String(r.path),
            repoId,
            repoRoot,
            JSON.stringify(r.baseChangeIds),
            String(r.rootChangeId),
            JSON.stringify([r.rootChangeId]),
            String(r.rootSessionId),
            String(r.createdAt ?? now.toISOString()),
            String(r.updatedAt ?? now.toISOString()),
          );
        if (result.changes) adopted.push(String(r.id));
        else {
          const byId = db
            .prepare("SELECT id,name,path,repo_id,repo_root FROM workspace WHERE id=?")
            .get(String(r.id));
          const byRepoName = db
            .prepare(
              "SELECT id,name,path,repo_id,repo_root FROM workspace WHERE repo_id=? AND name=?",
            )
            .get(repoId, String(r.name));
          const evidence = {
            index,
            incoming: { id: r.id, name: r.name, path: r.path, repoId, repoRoot },
            conflicts: { byId: byId ?? null, byRepoName: byRepoName ?? null },
          };
          collisions.push(evidence);
          quarantine(db, now, "migration_insert_collision", {
            source,
            sha256: digest,
            ...evidence,
          });
        }
      }
      const ledgerEvidence = JSON.stringify({ source, sha256: digest, adopted, collisions }).slice(
        0,
        8192,
      );
      // Unresolved input remains an incident diagnostic; completion authority
      // lives only in migration_ledger.
      if (collisions.length)
        quarantine(db, now, "migration_unresolved", {
          source,
          sha256: digest,
          adopted,
          collisions,
        });
      db.prepare(
        "INSERT INTO migration_ledger(source,digest,state,completed_at,evidence) VALUES('workspaces_json',?,?,?,?) ON CONFLICT(source,digest) DO UPDATE SET state=excluded.state,completed_at=excluded.completed_at,evidence=excluded.evidence",
      ).run(
        digest,
        collisions.length ? "unresolved" : "completed",
        now.toISOString(),
        ledgerEvidence,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    // A partial adoption is deliberately unresolved. Keep the source as the recovery authority.
    if (collisions.length) return undefined;
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
    db.prepare("DELETE FROM operation_lease WHERE scope='migration' AND token=?").run(leaseToken);
  }
}
