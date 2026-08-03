import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { StoragePaths } from "../storage/paths.ts";
import { privateChild } from "../storage/paths.ts";
import type { TaskId, TaskState } from "./authority.ts";
import type { HumanTaskAuthority } from "./host-authority.ts";
import { editTaskBody, resolveTaskEditor } from "./editor.ts";

export interface TaskDashboardRow {
  taskId: TaskId;
  displayId: string;
  title: string;
  state: TaskState;
  revision: number;
  digest: string;
  archived: boolean;
  updatedAt: string;
  provenanceSessionId?: string;
}

/** SQLite-backed, repository-scoped row source for the shared dashboard. */
export class TaskDashboardAdapter {
  private readonly db: DatabaseSync;
  private readonly repoId: string;
  private readonly authority: HumanTaskAuthority;
  private readonly paths: StoragePaths;
  private readonly importUi?: {
    input(label: string, placeholder?: string): Promise<string | undefined>;
    send(message: string): void | Promise<void>;
    trace(event: FixedRevisionImport): void | Promise<void>;
    principal: string;
  };
  constructor(
    db: DatabaseSync,
    repoId: string,
    authority: HumanTaskAuthority,
    paths: StoragePaths,
    importUi?: TaskDashboardAdapter["importUi"],
  ) {
    this.db = db;
    this.repoId = repoId;
    this.authority = authority;
    this.paths = paths;
    this.importUi = importUi;
  }

  list(archived: boolean): TaskDashboardRow[] {
    const rows = this.db
      .prepare(`SELECT task_id,display_id,title,state,current_revision,current_digest,
        archived_at,updated_at,provenance_session_id FROM task WHERE repo_id=? AND
        archived_at IS ${archived ? "NOT " : ""}NULL ORDER BY updated_at DESC,display_seq DESC`)
      .all(this.repoId) as Record<string, unknown>[];
    return rows.map((row) => ({
      taskId: String(row.task_id) as TaskId,
      displayId: String(row.display_id),
      title: String(row.title),
      state: row.state as TaskState,
      revision: Number(row.current_revision),
      digest: String(row.current_digest),
      archived: Boolean(row.archived_at),
      updatedAt: String(row.updated_at),
      ...(row.provenance_session_id
        ? { provenanceSessionId: String(row.provenance_session_id) }
        : {}),
    }));
  }

  archiveOrRestore(row: TaskDashboardRow): TaskDashboardRow {
    if (row.archived) this.authority.restore(row.taskId);
    else this.authority.archive(row.taskId);
    return (
      this.list(row.archived).find((candidate) => candidate.taskId === row.taskId) ??
      this.list(!row.archived).find((candidate) => candidate.taskId === row.taskId)!
    );
  }

  transition(row: TaskDashboardRow, to: TaskState): void {
    this.authority.transition(randomUUID(), row.taskId, row.state, row.revision, to);
  }

  async create(title?: string): Promise<void> {
    const editor = resolveTaskEditor(undefined);
    if (!editor) throw new Error("No task editor is available; configure EDITOR.");
    const emptyDigest = createHash("sha256").update("").digest("hex");
    const result = await editTaskBody({
      runtimeRoot: this.paths.runtime,
      taskId: "new-task",
      revision: 0,
      digest: emptyDigest,
      body: "",
      editor,
      current: () => ({ revision: 0, digest: emptyDigest }),
      commit: (body) => this.authority.create(randomUUID(), title?.trim() || null, body),
    });
    if (result.status === "error" || result.status === "refused") throw new Error(result.message);
    if (result.status === "unchanged") throw new Error("Task creation cancelled: body is empty.");
  }

  async edit(row: TaskDashboardRow): Promise<void> {
    if (row.archived) throw new Error("Archived tasks cannot be edited; restore the task first.");
    const editor = resolveTaskEditor(undefined);
    if (!editor) throw new Error("No task editor is available; configure EDITOR.");
    const body = new TextDecoder("utf-8", { fatal: true }).decode(
      readFileSync(
        join(privateChild(this.paths.taskBodies, this.repoId, row.taskId), `${row.revision}.md`),
      ),
    );
    const result = await editTaskBody({
      runtimeRoot: this.paths.runtime,
      taskId: row.taskId,
      revision: row.revision,
      digest: row.digest,
      body,
      editor,
      current: () => {
        const current = this.list(false).find((candidate) => candidate.taskId === row.taskId);
        return { revision: current?.revision ?? -1, digest: current?.digest ?? "" };
      },
      commit: (nextBody) => this.authority.revise(randomUUID(), row.taskId, row.revision, nextBody),
    });
    if (result.status === "error" || result.status === "refused") throw new Error(result.message);
  }

  async importRevision(row: TaskDashboardRow): Promise<FixedRevisionImport | undefined> {
    if (!this.importUi) throw new Error("Fixed task revision import is unavailable.");
    const revisionText = await this.importUi.input(
      `Import ${row.displayId}: immutable revision`,
      String(row.revision),
    );
    if (revisionText === undefined) return undefined;
    const revision = Number(revisionText.trim());
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Invalid task revision");
    const knownDigest = this.revisionDigest(row.taskId, revision);
    if (!knownDigest) throw new Error("Exact task revision is unavailable");
    return importFixedRevision({
      db: this.db,
      paths: this.paths,
      repoId: this.repoId,
      principal: this.importUi.principal,
      taskId: row.taskId,
      revision,
      expectedDigest: knownDigest,
      sendMessage: (message) => this.importUi!.send(message),
      appendTrace: (event) => this.importUi!.trace(event),
    });
  }

  revisionDigest(taskId: TaskId, revision: number): string | undefined {
    const row = this.db
      .prepare("SELECT digest FROM task_revision WHERE task_id=? AND revision=?")
      .get(taskId, revision) as { digest: string } | undefined;
    return row?.digest;
  }
}

export interface FixedRevisionImport {
  taskId: TaskId;
  displayId: string;
  revision: number;
  digest: string;
  body: string;
  message: string;
  deliveryId: string;
}

/**
 * Reads and verifies one immutable revision, then records its receipt atomically.
 * The caller must send `message` with `{deliverAs:"nextTurn", triggerTurn:false}`.
 */
export function prepareFixedRevisionImport(options: {
  db: DatabaseSync;
  paths: StoragePaths;
  repoId: string;
  principal: string;
  taskId: TaskId;
  revision: number;
  expectedDigest: string;
}): FixedRevisionImport {
  if (!Number.isSafeInteger(options.revision) || options.revision < 1)
    throw new Error("Invalid task revision");
  const row = options.db
    .prepare(`SELECT t.display_id,r.digest,r.relative_path FROM task t JOIN task_revision r
      ON r.task_id=t.task_id WHERE t.repo_id=? AND t.task_id=? AND r.revision=? AND r.digest=?`)
    .get(options.repoId, options.taskId, options.revision, options.expectedDigest) as
    | { display_id: string; digest: string; relative_path: string }
    | undefined;
  if (!row) throw new Error("Exact task revision is unavailable");
  const expectedRelative = join(
    "tasks",
    "bodies",
    options.repoId,
    options.taskId,
    `${options.revision}.md`,
  );
  if (row.relative_path !== expectedRelative) throw new Error("Task revision path is invalid");
  const bytes = readFileSync(
    join(
      privateChild(options.paths.taskBodies, options.repoId, options.taskId),
      `${options.revision}.md`,
    ),
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== options.expectedDigest || digest !== row.digest)
    throw new Error("Task revision digest mismatch");
  const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const deliveryId = `delivery_${randomUUID()}`;
  options.db.exec("BEGIN IMMEDIATE");
  try {
    const stillExact = options.db
      .prepare(
        "SELECT 1 FROM task_revision r JOIN task t ON t.task_id=r.task_id WHERE t.repo_id=? AND r.task_id=? AND r.revision=? AND r.digest=?",
      )
      .get(options.repoId, options.taskId, options.revision, options.expectedDigest);
    if (!stillExact) throw new Error("Exact task revision is unavailable");
    options.db
      .prepare(
        "INSERT INTO task_delivery(delivery_id,task_id,repo_id,principal,kind,revision,delivered_at) VALUES(?,?,?,?,'read',?,?)",
      )
      .run(
        deliveryId,
        options.taskId,
        options.repoId,
        options.principal,
        options.revision,
        new Date().toISOString(),
      );
    options.db.exec("COMMIT");
  } catch (error) {
    try {
      options.db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
  const message = `[Task ${row.display_id} revision ${options.revision} sha256:${digest}]\n\n${body}`;
  return {
    taskId: options.taskId,
    displayId: row.display_id,
    revision: options.revision,
    digest,
    body,
    message,
    deliveryId,
  };
}

/** Receipt-before-send orchestration; trace is appended only after accepted delivery. */
export async function importFixedRevision(
  options: Parameters<typeof prepareFixedRevisionImport>[0] & {
    sendMessage(
      message: string,
      options: { deliverAs: "nextTurn"; triggerTurn: false },
    ): void | Promise<void>;
    appendTrace(event: FixedRevisionImport): void | Promise<void>;
  },
): Promise<FixedRevisionImport> {
  const prepared = prepareFixedRevisionImport(options);
  await options.sendMessage(prepared.message, { deliverAs: "nextTurn", triggerTurn: false });
  await options.appendTrace(prepared);
  return prepared;
}
