import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { privateChild, type StoragePaths } from "../storage/paths.ts";

export class TaskUnavailableError extends Error {
  constructor() {
    super("Task is unavailable");
  }
}
export class TaskInvalidError extends Error {
  readonly code = "invalid";
  constructor(message = "Invalid task action") {
    super(message.slice(0, 160));
  }
}
export type AgentTaskAction =
  | { action: "transition"; to: "ready" | "doing" | "blocked" | "done" }
  | { action: "add_note"; note: string }
  | { action: "set_title"; title: string };

/** The sole repository-scoped mutation/query chokepoint exposed to model tools. */
export class TaskAgentAuthority {
  private db: DatabaseSync;
  private paths: StoragePaths;
  private repoId: string;
  private principal: string;
  constructor(db: DatabaseSync, paths: StoragePaths, repoId: string, principal: string) {
    this.db = db;
    this.paths = paths;
    this.repoId = repoId;
    this.principal = principal;
    if (
      !principal ||
      principal.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(principal) ||
      !db.prepare("SELECT 1 FROM repository WHERE repo_id=? AND identity_proven=1").get(repoId)
    )
      throw new TaskUnavailableError();
  }
  list() {
    try {
      return this.db
        .prepare(
          "SELECT task_id,display_id,title,state,current_revision revision FROM task WHERE repo_id=? AND archived_at IS NULL AND state IN('ready','doing','blocked') ORDER BY display_seq",
        )
        .all(this.repoId);
    } catch {
      throw new TaskUnavailableError();
    }
  }
  read(id: string) {
    try {
      return this.tx(() => this.snapshot(this.visible(id), true));
    } catch {
      throw new TaskUnavailableError();
    }
  }
  update(id: string, action: AgentTaskAction) {
    try {
      return this.tx(() => {
        // Visibility is resolved first so invalid input cannot probe hidden tasks.
        const task = this.visible(id);
        const now = new Date().toISOString();
        if (
          !action ||
          typeof action !== "object" ||
          !["transition", "add_note", "set_title"].includes(action.action)
        )
          throw new TaskInvalidError();
        if (
          (action.action === "transition" &&
            ("note" in action || "title" in action || !("to" in action))) ||
          (action.action === "add_note" &&
            ("to" in action || "title" in action || !("note" in action))) ||
          (action.action === "set_title" &&
            ("to" in action || "note" in action || !("title" in action)))
        )
          throw new TaskInvalidError();
        if (action.action === "add_note") {
          const note = cleanNote(action.note);
          this.db
            .prepare("INSERT INTO task_note VALUES(?,?,?,'agent',?,?,?)")
            .run(`note_${randomUUID()}`, task.task_id, this.repoId, this.principal, note, now);
        } else if (action.action === "set_title") {
          const title = cleanTitle(action.title);
          this.db
            .prepare(
              "INSERT INTO task_audit(audit_id,task_id,repo_id,actor,principal,operation,from_title,to_title,created_at) VALUES(?,?,?,'agent',?,'set_title',?,?,?)",
            )
            .run(
              `audit_${randomUUID()}`,
              task.task_id,
              this.repoId,
              this.principal,
              task.title,
              title,
              now,
            );
          const changed = this.db
            .prepare(
              "UPDATE task SET title=?,updated_at=? WHERE task_id=? AND repo_id=? AND archived_at IS NULL",
            )
            .run(title, now, task.task_id, this.repoId);
          if (changed.changes !== 1) throw new Error();
        } else {
          const allowed: Record<string, readonly string[]> = {
            ready: ["doing", "blocked"],
            doing: ["blocked", "ready", "done"],
            blocked: ["doing", "ready"],
          };
          if (!allowed[String(task.state)]?.includes(action.to))
            throw new TaskInvalidError("Invalid visible task transition");
          this.db
            .prepare(
              "INSERT INTO task_audit(audit_id,task_id,repo_id,actor,principal,operation,from_state,to_state,created_at) VALUES(?,?,?,'agent',?,'transition',?,?,?)",
            )
            .run(
              `audit_${randomUUID()}`,
              task.task_id,
              this.repoId,
              this.principal,
              task.state,
              action.to,
              now,
            );
          const changed = this.db
            .prepare(
              "UPDATE task SET state=?,updated_at=? WHERE task_id=? AND repo_id=? AND state=? AND archived_at IS NULL",
            )
            .run(action.to, now, task.task_id, this.repoId, task.state);
          if (changed.changes !== 1) throw new Error();
        }
        const settled = this.db
          .prepare(
            "SELECT task_id,display_id,title,state,current_revision revision FROM task WHERE task_id=? AND repo_id=?",
          )
          .get(task.task_id, this.repoId);
        if (!settled) throw new Error();
        return this.snapshot(settled as any, true);
      });
    } catch (error) {
      if (error instanceof TaskInvalidError) throw error;
      throw new TaskUnavailableError();
    }
  }
  private snapshot(task: any, receipt: boolean) {
    let body: string;
    try {
      const bytes = readFileSync(
        join(
          privateChild(this.paths.taskBodies, this.repoId, String(task.task_id)),
          `${Number(task.revision)}.md`,
        ),
      );
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new TaskUnavailableError();
    }
    const notes = this.db
      .prepare(
        "SELECT body,actor,principal,created_at FROM task_note WHERE task_id=? ORDER BY rowid",
      )
      .all(task.task_id);
    if (!receipt) return { ...task, body, notes };
    const deliveredAt = new Date().toISOString(),
      deliveryId = `delivery_${randomUUID()}`;
    this.db
      .prepare(
        "INSERT INTO task_delivery(delivery_id,task_id,repo_id,principal,kind,revision,delivered_at) VALUES(?,?,?,?,'read',?,?)",
      )
      .run(
        deliveryId,
        task.task_id,
        this.repoId,
        this.principal,
        Number(task.revision),
        deliveredAt,
      );
    return {
      ...task,
      body,
      notes,
      receipt: { deliveryId, kind: "read", revision: Number(task.revision), deliveredAt },
    };
  }
  private visible(id: string): any {
    if (typeof id !== "string" || id.length > 128) throw new TaskUnavailableError();
    const row = this.db
      .prepare(
        "SELECT task_id,display_id,title,state,current_revision revision FROM task WHERE repo_id=? AND (task_id=? OR display_id=?) AND archived_at IS NULL AND state IN('ready','doing','blocked')",
      )
      .get(this.repoId, id, id);
    if (!row) throw new TaskUnavailableError();
    return row;
  }
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
}
function cleanTitle(value: unknown) {
  if (typeof value !== "string") throw new TaskInvalidError("Title must be text");
  const title = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!title || title.length > 512 || /[\u0000-\u001f\u007f]/u.test(title))
    throw new TaskInvalidError("Title must be nonblank and at most 512 characters");
  return title;
}
function cleanNote(value: unknown) {
  if (typeof value !== "string") throw new TaskInvalidError("Note must be text");
  const note = value.normalize("NFC").trim();
  if (
    !note ||
    Buffer.byteLength(note) > 16384 ||
    /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(note)
  )
    throw new TaskInvalidError("Note must be nonblank and at most 16384 bytes");
  return note;
}
