import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export type ProcessState = { state: "dead" | "unknown" } | { state: "live"; start: string };
export interface LeaseOptions {
  scope: string;
  owner: string;
  pid?: number;
  pidStart: string;
  waitMs?: number;
  staleMs?: number;
  heartbeatMs?: number;
  processState?: (pid: number) => ProcessState;
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Conservative OS process identity probe. Permission/format ambiguity fails closed. */
export function processState(pid: number): ProcessState {
  try {
    process.kill(pid, 0);
  } catch (e: any) {
    return e?.code === "ESRCH" ? { state: "dead" } : { state: "unknown" };
  }
  // Linux exposes an immutable start tick in field 22. Parse after the final
  // ')' because comm (field 2) may itself contain spaces and parentheses.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    const start = fields[19];
    if (start && /^\d+$/.test(start)) return { state: "live", start: `proc:${start}` };
  } catch {
    // Non-Linux and restricted procfs fall through to the portable probe.
  }
  try {
    const start = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
    }).trim();
    return start ? { state: "live", start: `ps:${start}` } : { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}

export function currentProcessStart(): string {
  const state = processState(process.pid);
  if (state.state !== "live") throw new Error("Cannot prove current process start identity");
  return state.start;
}

/**
 * SQLite custody lease. Expiry/heartbeat is diagnostic, never liveness
 * authority: an expired lease is stealable only after the prior process is
 * proved dead or PID reuse is proved by a different process start identity.
 */
export async function withOperationLease<T>(
  db: DatabaseSync,
  options: LeaseOptions,
  operation: () => Promise<T> | T,
): Promise<T> {
  const token = randomUUID();
  const pid = options.pid ?? process.pid;
  const staleMs = options.staleMs ?? 15_000;
  const deadline = Date.now() + (options.waitMs ?? 15_000);
  const probe = options.processState ?? processState;
  while (true) {
    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db
        .prepare("SELECT * FROM operation_lease WHERE scope=?")
        .get(options.scope) as any;
      let steal = !row;
      if (row && Number(row.expires_at) <= now) {
        const state = probe(Number(row.pid));
        steal =
          state.state === "dead" ||
          (state.state === "live" && state.start !== String(row.pid_start));
      }
      if (steal) {
        db.prepare(
          "INSERT INTO operation_lease(scope,owner,token,pid,pid_start,heartbeat_at,expires_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET owner=excluded.owner,token=excluded.token,pid=excluded.pid,pid_start=excluded.pid_start,heartbeat_at=excluded.heartbeat_at,expires_at=excluded.expires_at",
        ).run(options.scope, options.owner, token, pid, options.pidStart, now, now + staleMs);
        db.exec("COMMIT");
        break;
      }
      db.exec("ROLLBACK");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    if (now >= deadline) throw new Error(`Timed out acquiring operation lease ${options.scope}`);
    await delay(Math.min(25, Math.max(1, deadline - now)));
  }
  const heartbeat = setInterval(
    () => {
      const now = Date.now();
      db.prepare(
        "UPDATE operation_lease SET heartbeat_at=?,expires_at=? WHERE scope=? AND token=? AND owner=?",
      ).run(now, now + staleMs, options.scope, token, options.owner);
    },
    options.heartbeatMs ?? Math.max(10, Math.floor(staleMs / 3)),
  );
  heartbeat.unref();
  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    db.prepare(
      "DELETE FROM operation_lease WHERE scope=? AND token=? AND owner=? AND pid_start=?",
    ).run(options.scope, token, options.owner, options.pidStart);
  }
}
