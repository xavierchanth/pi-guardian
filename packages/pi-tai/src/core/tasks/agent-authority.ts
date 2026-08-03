import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { StoragePaths } from "../storage/paths.ts";
import type { TaskId, TaskState } from "./authority.ts";

export class TaskUnavailableError extends Error {
  constructor() {
    super("Task is unavailable");
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
      !db.prepare("SELECT 1 FROM repository WHERE repo_id=? AND identity_proven=1").get(repoId)
    )
      throw new TaskUnavailableError();
  }
  list() {
    return this.db
      .prepare(
        "SELECT task_id,display_id,title,state,current_revision revision FROM task WHERE repo_id=? AND archived_at IS NULL AND state IN('ready','doing','blocked') ORDER BY display_seq",
      )
      .all(this.repoId);
  }
  read(id: string) {
    const task = this.visible(id);
    const revision = Number(task.revision);
    const body = readFileSync(
      join(this.paths.taskBodies, this.repoId, String(task.task_id), `${revision}.md`),
      "utf8",
    );
    const deliveredAt = new Date().toISOString();
    const deliveryId = `delivery_${randomUUID()}`;
    this.db
      .prepare("INSERT INTO task_delivery VALUES(?,?,?,?,?,'read',?,?)")
      .run(deliveryId, task.task_id, this.repoId, this.principal, revision, deliveredAt);
    const notes = this.db
      .prepare(
        "SELECT body,actor,principal,created_at FROM task_note WHERE task_id=? ORDER BY rowid",
      )
      .all(task.task_id);
    return { ...task, body, notes, receipt: { deliveryId, kind: "read", revision, deliveredAt } };
  }
  update(id: string, action: AgentTaskAction) {
    const task = this.visible(id);
    const now = new Date().toISOString();
    if (action.action === "add_note") {
      const note = action.note.normalize("NFC").trim();
      if (!note || note.length > 16384) throw new TaskUnavailableError();
      this.db
        .prepare("INSERT INTO task_note VALUES(?,?,?,'agent',?,?,?)")
        .run(`note_${randomUUID()}`, task.task_id, this.repoId, this.principal, note, now);
    } else if (action.action === "set_title") {
      const title = action.title.normalize("NFC").trim().replace(/\s+/gu, " ");
      if (!title || title.length > 512 || /[\u0000-\u001f\u007f]/u.test(title))
        throw new TaskUnavailableError();
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
      this.db
        .prepare("UPDATE task SET title=?,updated_at=? WHERE task_id=? AND repo_id=?")
        .run(title, now, task.task_id, this.repoId);
    } else {
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
      try {
        this.db
          .prepare("UPDATE task SET state=?,updated_at=? WHERE task_id=? AND repo_id=?")
          .run(action.to, now, task.task_id, this.repoId);
      } catch {
        throw new TaskUnavailableError();
      }
    }
    return this.read(id);
  }
  private visible(id: string): any {
    const row = this.db
      .prepare(
        "SELECT task_id,display_id,title,state,current_revision revision FROM task WHERE repo_id=? AND (task_id=? OR display_id=?) AND archived_at IS NULL AND state IN('ready','doing','blocked')",
      )
      .get(this.repoId, id, id) as any;
    if (!row) throw new TaskUnavailableError();
    return row;
  }
}
