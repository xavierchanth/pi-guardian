export const TASK_STATES = ["open", "ready", "doing", "blocked", "done", "dropped"] as const;
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
