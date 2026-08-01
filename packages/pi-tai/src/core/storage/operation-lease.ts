import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface LeaseOptions {
  scope: string;
  owner: string;
  pid?: number;
  pidStart: string;
  waitMs?: number;
  staleMs?: number;
  heartbeatMs?: number;
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * SQLite custody lease. Scope names impose global lock ordering: callers that
 * need several leases must acquire lexical scope order. Ownership includes PID
 * start identity, so PID reuse cannot inherit a lease.
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
  while (true) {
    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db
        .prepare("SELECT * FROM operation_lease WHERE scope=?")
        .get(options.scope) as any;
      if (
        !row ||
        Number(row.expires_at) <= now ||
        (Number(row.pid) === pid && String(row.pid_start) !== options.pidStart)
      ) {
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
