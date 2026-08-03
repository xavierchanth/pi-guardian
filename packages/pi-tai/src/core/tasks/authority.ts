import type { DatabaseSync } from "node:sqlite";

export const TASK_STATES = [
  "open",
  "ready",
  "doing",
  "blocked",
  "done",
  "dropped",
  "archived",
] as const;
export type TaskState = (typeof TASK_STATES)[number];
export type TaskId = string & { readonly __taskId: unique symbol };
export interface AgentVisibleTask {
  readonly taskId: TaskId;
  readonly displayId: string;
  readonly state: Exclude<TaskState, "open">;
  readonly title: string;
  readonly revision: number;
  readonly digest: string;
}

/** Repository-bound, non-enumerating agent view. Open drafts are deliberately indistinguishable from absence. */
export class AgentTaskQuery {
  private readonly db: DatabaseSync;
  private readonly repoId: string;
  constructor(db: DatabaseSync, repoId: string) {
    this.db = db;
    this.repoId = repoId;
    const proved = db
      .prepare("SELECT 1 FROM repository WHERE repo_id=? AND identity_proven=1")
      .get(repoId);
    if (!proved) throw new Error("Repository identity is not proven");
  }
  list(): AgentVisibleTask[] {
    return this.db
      .prepare(
        "SELECT task_id,display_id,state,title,current_revision,current_digest FROM task WHERE repo_id=? AND state<>'open' ORDER BY display_seq",
      )
      .all(this.repoId)
      .map((row) => visible(row as Record<string, unknown>));
  }
  get(id: TaskId): AgentVisibleTask | undefined {
    const row = this.db
      .prepare(
        "SELECT task_id,display_id,state,title,current_revision,current_digest FROM task WHERE repo_id=? AND task_id=? AND state<>'open'",
      )
      .get(this.repoId, id) as Record<string, unknown> | undefined;
    return row ? visible(row) : undefined;
  }
}
function visible(r: Record<string, unknown>): AgentVisibleTask {
  return {
    taskId: r.task_id as TaskId,
    displayId: String(r.display_id),
    state: r.state as Exclude<TaskState, "open">,
    title: String(r.title),
    revision: Number(r.current_revision),
    digest: String(r.current_digest),
  };
}
