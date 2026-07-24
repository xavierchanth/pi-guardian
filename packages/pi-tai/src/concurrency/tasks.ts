import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HostConcurrencyState } from "./host-state.ts";

export type TaskOwnerRole = "thinker" | "planner" | "worker" | "reviewer" | "scout" | "researcher";
export interface UserMessageEvidenceV1 { readonly messageId: string; readonly contentHash: string; readonly content: string; readonly observedAt: string; }
export interface TaskDirectionV1 { readonly directionId: string; readonly evidence: UserMessageEvidenceV1; readonly summary: string; readonly recordedByContextId: string; readonly recordedAt: string; }
export interface TaskPlanRevisionV1 { readonly revisionId: string; readonly authorContextId: string; readonly authorRole: "thinker" | "planner"; readonly markdown: string; readonly rationale: string; readonly directionIds?: readonly string[]; readonly recordedAt: string; readonly workspaceOperationId?: string; }
export type TaskExecutionBindingV1 =
  | { readonly phase: "unassigned" }
  | { readonly phase: "bound"; readonly contextId: string }
  | { readonly phase: "root"; readonly rootSessionId: string };
export interface PersistedTaskV1 {
  readonly version: 1;
  readonly taskId: string;
  readonly rootSessionId: string;
  readonly parentTaskId?: string;
  readonly ownerRole: TaskOwnerRole;
  readonly createdByContextId: string;
  readonly goal: { readonly objective: string; readonly acceptanceCriteria: readonly string[]; readonly constraints: readonly string[]; readonly userRequest: UserMessageEvidenceV1 };
  readonly assignment?: { readonly objective: string; readonly acceptanceCriteria: readonly string[]; readonly constraints: readonly string[] };
  readonly execution: TaskExecutionBindingV1;
  readonly childTaskIds: readonly string[];
  readonly directions: readonly TaskDirectionV1[];
  readonly planRevisions: readonly TaskPlanRevisionV1[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface TaskSnapshotReceipt { readonly snapshotId: string; readonly taskId: string; readonly digest: string; readonly path: string; readonly bytes: number; readonly createdAt: string; }
export type TaskPlanProjectionV1 =
  | { readonly state: "none" }
  | { readonly state: "effective"; readonly revision: TaskPlanRevisionV1 }
  | { readonly state: "full"; readonly revisions: readonly (TaskPlanRevisionV1 & { readonly authority: "current" | "superseded" })[] };
export interface TaskViewV1 {
  readonly taskId: string;
  readonly parentTaskId?: string;
  readonly ownerRole: TaskOwnerRole;
  readonly goal: PersistedTaskV1["goal"];
  readonly assignment?: PersistedTaskV1["assignment"];
  readonly execution: TaskExecutionBindingV1;
  readonly childTaskIds: readonly string[];
  readonly plan: TaskPlanProjectionV1;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface TaskStatusProjectionV1 {
  readonly viewerRole: TaskOwnerRole;
  readonly rootTaskId: string;
  readonly focusTaskId: string;
  readonly directions: readonly TaskDirectionV1[];
  readonly tasks: readonly TaskViewV1[];
}

export interface TaskStore { create(record: PersistedTaskV1): Promise<void>; get(taskId: string): Promise<PersistedTaskV1 | undefined>; list(): Promise<PersistedTaskV1[]>; update(taskId: string, reducer: (record: PersistedTaskV1) => PersistedTaskV1): Promise<PersistedTaskV1>; }
export class FileTaskStore implements TaskStore {
  readonly root: string; private readonly updates = new Map<string, Promise<void>>(); constructor(root: string) { this.root = resolve(root); }
  async create(record: PersistedTaskV1): Promise<void> { const value = validateTask(record); await mkdir(this.root, { recursive: true, mode: 0o700 }); await writeFile(this.path(value.taskId), serialize(value), { encoding: "utf8", mode: 0o600, flag: "wx" }); }
  async get(taskId: string): Promise<PersistedTaskV1 | undefined> { try { return validateTask(JSON.parse(await readFile(this.path(taskId), "utf8"))); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
  async list(): Promise<PersistedTaskV1[]> { try { const output: PersistedTaskV1[] = []; for (const name of (await readdir(this.root)).filter((item) => item.endsWith(".json")).sort()) { const value = await this.get(name.slice(0, -5)); if (value) output.push(value); } return output; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
  update(taskId: string, reducer: (record: PersistedTaskV1) => PersistedTaskV1): Promise<PersistedTaskV1> { managedId(taskId, "task"); const prior = (this.updates.get(taskId) ?? Promise.resolve()).catch(() => undefined); let release!: () => void; const current = new Promise<void>((done) => { release = done; }); const chain = prior.then(() => current); this.updates.set(taskId, chain); return prior.then(async () => { const existing = await this.get(taskId); if (!existing) throw new Error(`Unknown task: ${taskId}`); const next = validateTask(reducer(structuredClone(existing))); if (next.taskId !== taskId) throw new Error("Task update cannot change identity."); assertImmutableTask(existing, next); const temporary = `${this.path(taskId)}.${randomUUID()}.tmp`; await writeFile(temporary, serialize(next), { encoding: "utf8", mode: 0o600, flag: "wx" }); await rename(temporary, this.path(taskId)); return next; }).finally(() => { release(); if (this.updates.get(taskId) === chain) this.updates.delete(taskId); }); }
  private path(taskId: string): string { managedId(taskId, "task"); return join(this.root, `${taskId}.json`); }
}

export class HostTaskStore implements TaskStore {
  private readonly state: HostConcurrencyState;
  constructor(state: HostConcurrencyState) { this.state = state; }
  async create(record: PersistedTaskV1): Promise<void> {
    const value = validateTask(record);
    await this.state.mutateSegment<PersistedTaskV1>("tasks", "task.created", { taskId: value.taskId }, (tasks) => {
      if (tasks.some((task) => task.taskId === value.taskId)) throw new Error(`Task already exists: ${value.taskId}`);
      return [...tasks, value];
    });
  }
  async get(taskId: string): Promise<PersistedTaskV1 | undefined> { return (await this.list()).find((task) => task.taskId === taskId); }
  async list(): Promise<PersistedTaskV1[]> { return (await this.state.readSegment<PersistedTaskV1>("tasks")).map(validateTask); }
  async update(taskId: string, reducer: (record: PersistedTaskV1) => PersistedTaskV1): Promise<PersistedTaskV1> {
    let output: PersistedTaskV1 | undefined;
    await this.state.mutateSegment<PersistedTaskV1>("tasks", "task.replaced", { taskId }, (tasks) => tasks.map((task) => {
      if (task.taskId !== taskId) return task;
      const next = validateTask(reducer(structuredClone(task))); assertImmutableTask(task, next); output = next; return next;
    }));
    if (!output) throw new Error(`Unknown task: ${taskId}`); return output;
  }
}

export class TaskService {
  private readonly store: TaskStore; private readonly artifactRoot: string; private readonly now: () => string;
  constructor(store: TaskStore, artifactRoot: string, now = () => new Date().toISOString()) { this.store = store; this.artifactRoot = artifactRoot; this.now = now; }
  async createRoot(input: { rootSessionId: string; thinkerContextId: string; objective: string; acceptanceCriteria?: readonly string[]; constraints?: readonly string[]; userRequest: UserMessageEvidenceV1 }): Promise<PersistedTaskV1> { const at = this.now(); const record: PersistedTaskV1 = { version: 1, taskId: `task-${randomUUID()}`, rootSessionId: input.rootSessionId, ownerRole: "thinker", createdByContextId: input.thinkerContextId, goal: { objective: bounded(input.objective, "objective", 16_000), acceptanceCriteria: boundedList(input.acceptanceCriteria ?? [], "acceptance criteria"), constraints: boundedList(input.constraints ?? [], "constraints"), userRequest: validateEvidence(input.userRequest) }, execution: { phase: "root", rootSessionId: input.rootSessionId }, childTaskIds: [], directions: [], planRevisions: [], createdAt: at, updatedAt: at }; await this.store.create(record); return record; }
  async assign(parentTaskId: string, input: { ownerRole: Exclude<TaskOwnerRole, "thinker">; creatorContextId: string; objective: string; acceptanceCriteria?: readonly string[]; constraints?: readonly string[] }): Promise<PersistedTaskV1> { const parent = await this.require(parentTaskId); const at = this.now(); const child: PersistedTaskV1 = { version: 1, taskId: `task-${randomUUID()}`, rootSessionId: parent.rootSessionId, parentTaskId, ownerRole: input.ownerRole, createdByContextId: input.creatorContextId, goal: parent.goal, assignment: { objective: bounded(input.objective, "assignment objective", 16_000), acceptanceCriteria: boundedList(input.acceptanceCriteria ?? [], "assignment acceptance criteria"), constraints: boundedList(input.constraints ?? [], "assignment constraints") }, execution: { phase: "unassigned" }, childTaskIds: [], directions: [], planRevisions: [], createdAt: at, updatedAt: at }; await this.store.create(child); await this.store.update(parentTaskId, (record) => ({ ...record, childTaskIds: [...record.childTaskIds, child.taskId], updatedAt: at })); return child; }
  async bind(taskId: string, contextId: string): Promise<PersistedTaskV1> { return this.store.update(taskId, (record) => { if (record.execution.phase !== "unassigned") throw new Error("Task execution is already bound."); return { ...record, execution: { phase: "bound", contextId }, updatedAt: this.now() }; }); }
  async appendPlan(taskId: string, input: { authorContextId: string; authorRole: "thinker" | "planner"; markdown: string; rationale: string; directionIds?: readonly string[]; workspaceOperationId?: string }): Promise<PersistedTaskV1> {
    const root = await this.rootOf(taskId);
    const knownDirections = new Set(root.directions.map((direction) => direction.directionId));
    const directionIds = uniqueIds(input.directionIds ?? [], "direction");
    for (const directionId of directionIds) if (!knownDirections.has(directionId)) throw new Error(`Unknown user direction: ${directionId}`);
    return this.store.update(taskId, (record) => {
      if (record.ownerRole !== input.authorRole) throw new Error("Only the owning thinker or planner may revise this task plan.");
      if (record.execution.phase === "bound" && record.execution.contextId !== input.authorContextId) throw new Error("Plan author does not own the bound task context.");
      const revision: TaskPlanRevisionV1 = {
        revisionId: `plan-${randomUUID()}`,
        authorContextId: input.authorContextId,
        authorRole: input.authorRole,
        markdown: bounded(input.markdown, "plan markdown", 64_000),
        rationale: bounded(input.rationale, "plan rationale", 8_000),
        ...(directionIds.length ? { directionIds } : {}),
        recordedAt: this.now(),
        ...(input.workspaceOperationId ? { workspaceOperationId: input.workspaceOperationId } : {}),
      };
      return { ...record, planRevisions: [...record.planRevisions, revision], updatedAt: revision.recordedAt };
    });
  }
  async recordDirection(taskId: string, input: { thinkerContextId: string; evidence: UserMessageEvidenceV1; summary: string }): Promise<PersistedTaskV1> { return this.store.update(taskId, (record) => { if (record.ownerRole !== "thinker" && record.parentTaskId !== undefined) throw new Error("User direction must be attached through the root thinker task."); const at = this.now(); const direction: TaskDirectionV1 = { directionId: `direction-${randomUUID()}`, evidence: validateEvidence(input.evidence), summary: bounded(input.summary, "direction summary", 8_000), recordedByContextId: input.thinkerContextId, recordedAt: at }; return { ...record, directions: [...record.directions, direction], updatedAt: at }; }); }
  async snapshot(taskId: string): Promise<TaskSnapshotReceipt> { const rootTask = await this.rootOf(taskId); const tree = await this.tree(rootTask.taskId); validateDirectionReferences(tree, rootTask.directions); const markdown = renderTaskSnapshot(tree); const content = Buffer.from(markdown, "utf8"); const digest = createHash("sha256").update(content).digest("hex"); const directory = resolve(this.artifactRoot, taskId); const root = resolve(this.artifactRoot); if (directory !== join(root, taskId)) throw new Error("Task snapshot path escaped its managed root."); await mkdir(directory, { recursive: true, mode: 0o700 }); const path = join(directory, `${digest}.md`); try { await writeFile(path, content, { mode: 0o600, flag: "wx" }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } return { snapshotId: `snapshot-${digest}`, taskId, digest, path, bytes: content.byteLength, createdAt: this.now() }; }
  async status(taskId: string, viewerRole: TaskOwnerRole): Promise<TaskStatusProjectionV1> {
    const focus = await this.require(taskId);
    const root = await this.rootOf(taskId);
    const full = viewerRole === "thinker" || viewerRole === "reviewer";
    const completeTree = await this.tree(root.taskId);
    validateDirectionReferences(completeTree, root.directions);
    const selected = full
      ? completeTree
      : viewerRole === "planner"
        ? await this.tree(focus.taskId)
        : await this.lineage(focus.taskId);
    const visibleIds = new Set(selected.map((task) => task.taskId));
    return {
      viewerRole,
      rootTaskId: root.taskId,
      focusTaskId: focus.taskId,
      directions: root.directions,
      tasks: selected.map((task) => projectTask(task, full, visibleIds)),
    };
  }
  async rootOf(taskId: string): Promise<PersistedTaskV1> { let task = await this.require(taskId); while (task.parentTaskId) task = await this.require(task.parentTaskId); return task; }
  async get(taskId: string): Promise<PersistedTaskV1 | undefined> { return this.store.get(taskId); }
  async findRoot(rootSessionId: string): Promise<PersistedTaskV1 | undefined> { return (await this.store.list()).filter((task) => task.rootSessionId === rootSessionId && task.parentTaskId === undefined).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]; }
  async tree(taskId: string): Promise<PersistedTaskV1[]> { const output: PersistedTaskV1[] = []; const visit = async (id: string) => { const task = await this.require(id); output.push(task); for (const child of task.childTaskIds) await visit(child); }; await visit(taskId); return output; }
  private async lineage(taskId: string): Promise<PersistedTaskV1[]> { const output: PersistedTaskV1[] = []; let task = await this.require(taskId); output.push(task); while (task.parentTaskId) { task = await this.require(task.parentTaskId); output.push(task); } return output.reverse(); }
  private async require(taskId: string): Promise<PersistedTaskV1> { const value = await this.store.get(taskId); if (!value) throw new Error(`Unknown task: ${taskId}`); return value; }
}

export function validateTask(input: unknown): PersistedTaskV1 {
  if (!object(input) || input.version !== 1) throw new Error("Task record must use version 1.");
  for (const key of ["taskId", "rootSessionId", "createdByContextId"] as const) managedId(nonempty(input[key], key), key);
  if (input.parentTaskId !== undefined) managedId(nonempty(input.parentTaskId, "parentTaskId"), "parent task");
  if (!["thinker", "planner", "worker", "reviewer", "scout", "researcher"].includes(String(input.ownerRole))) throw new Error("Invalid task owner role.");
  if (!object(input.goal)) throw new Error("Task goal is required.");
  bounded(nonempty(input.goal.objective, "goal objective"), "goal objective", 16_000);
  if (!Array.isArray(input.goal.acceptanceCriteria) || !Array.isArray(input.goal.constraints)) throw new Error("Task goal lists are required.");
  validateEvidence(input.goal.userRequest);
  if (input.assignment !== undefined && !object(input.assignment)) throw new Error("Task assignment is invalid.");
  if (!object(input.execution) || !["unassigned", "bound", "root"].includes(String(input.execution.phase))) throw new Error("Task execution binding is invalid.");
  if (input.execution.phase === "bound") managedId(nonempty(input.execution.contextId, "execution context"), "context");
  if (!Array.isArray(input.childTaskIds) || !Array.isArray(input.directions) || !Array.isArray(input.planRevisions)) throw new Error("Task collections are required.");
  const children = new Set<string>();
  for (const child of input.childTaskIds) { managedId(nonempty(child, "child task"), "child task"); if (children.has(child)) throw new Error("Duplicate child task."); children.add(child); }
  const directions = new Set<string>();
  for (const direction of input.directions) { validateDirection(direction); if (directions.has(direction.directionId)) throw new Error("Duplicate task direction."); directions.add(direction.directionId); }
  const revisions = new Set<string>();
  for (const revision of input.planRevisions) {
    validateRevision(revision);
    if (revisions.has(revision.revisionId)) throw new Error("Duplicate task plan revision.");
    revisions.add(revision.revisionId);
    if (revision.authorRole !== input.ownerRole) throw new Error("Task plan revision author must match the task owner role.");
  }
  if (input.planRevisions.length && input.ownerRole !== "thinker" && input.ownerRole !== "planner") throw new Error("Only thinker and planner tasks may contain plan revisions.");
  nonempty(input.createdAt, "createdAt");
  nonempty(input.updatedAt, "updatedAt");
  return input as unknown as PersistedTaskV1;
}
function assertImmutableTask(before: PersistedTaskV1, after: PersistedTaskV1): void { for (const key of ["taskId", "rootSessionId", "parentTaskId", "ownerRole", "createdByContextId", "createdAt"] as const) if (before[key] !== after[key]) throw new Error(`Task update cannot change immutable ${key}.`); if (JSON.stringify(before.goal) !== JSON.stringify(after.goal) || JSON.stringify(before.assignment) !== JSON.stringify(after.assignment)) throw new Error("Task update cannot rewrite goal or assignment."); if (after.directions.length < before.directions.length || JSON.stringify(after.directions.slice(0, before.directions.length)) !== JSON.stringify(before.directions)) throw new Error("Task directions are append-only."); if (after.planRevisions.length < before.planRevisions.length || JSON.stringify(after.planRevisions.slice(0, before.planRevisions.length)) !== JSON.stringify(before.planRevisions)) throw new Error("Task plan revisions are append-only."); }
function validateEvidence(value: unknown): UserMessageEvidenceV1 { if (!object(value)) throw new Error("User message evidence is required."); managedId(nonempty(value.messageId, "user message ID"), "user message"); const content = bounded(nonempty(value.content, "user message content"), "user message content", 64_000); const hash = nonempty(value.contentHash, "user content hash"); if (hash !== createHash("sha256").update(content).digest("hex")) throw new Error("User message evidence hash mismatch."); nonempty(value.observedAt, "user message observedAt"); return value as unknown as UserMessageEvidenceV1; }
function validateDirection(value: unknown): void { if (!object(value)) throw new Error("Task direction is invalid."); managedId(nonempty(value.directionId, "direction ID"), "direction"); validateEvidence(value.evidence); bounded(nonempty(value.summary, "direction summary"), "direction summary", 8_000); managedId(nonempty(value.recordedByContextId, "direction context"), "context"); nonempty(value.recordedAt, "direction recordedAt"); }
function validateRevision(value: unknown): void { if (!object(value)) throw new Error("Task plan revision is invalid."); managedId(nonempty(value.revisionId, "revision ID"), "plan revision"); managedId(nonempty(value.authorContextId, "plan author"), "context"); if (!["thinker", "planner"].includes(String(value.authorRole))) throw new Error("Invalid plan author role."); bounded(nonempty(value.markdown, "plan markdown"), "plan markdown", 64_000); bounded(nonempty(value.rationale, "plan rationale"), "plan rationale", 8_000); if (value.directionIds !== undefined) uniqueIds(value.directionIds, "direction"); nonempty(value.recordedAt, "plan recordedAt"); }
function renderTaskSnapshot(tasks: readonly PersistedTaskV1[]): string { return tasks.map((task, index) => { const current = task.planRevisions.at(-1)?.revisionId; return [`${"#".repeat(Math.min(index + 1, 6))} Task ${task.taskId}`, `Owner: ${task.ownerRole}`, `Goal: ${task.goal.objective}`, ...(task.assignment ? [`Assignment: ${task.assignment.objective}`] : []), ...task.directions.map((item) => `Direction ${item.directionId} (${item.evidence.messageId}): ${item.summary}\n\n${item.evidence.content}`), ...task.planRevisions.map((item) => `${item.revisionId === current ? "Current" : "Superseded"} plan revision ${item.revisionId} (${item.authorRole})${item.directionIds?.length ? `\nDirections: ${item.directionIds.join(", ")}` : ""}:\n\n${item.markdown}\n\nRationale: ${item.rationale}`)].join("\n\n"); }).join("\n\n"); }
function projectTask(task: PersistedTaskV1, full: boolean, visibleIds: ReadonlySet<string>): TaskViewV1 {
  const current = task.planRevisions.at(-1);
  const plan: TaskPlanProjectionV1 = full
    ? task.planRevisions.length
      ? { state: "full", revisions: task.planRevisions.map((revision, index) => ({ ...revision, authority: index === task.planRevisions.length - 1 ? "current" as const : "superseded" as const })) }
      : { state: "none" }
    : current
      ? { state: "effective", revision: current }
      : { state: "none" };
  return {
    taskId: task.taskId,
    ...(task.parentTaskId && visibleIds.has(task.parentTaskId) ? { parentTaskId: task.parentTaskId } : {}),
    ownerRole: task.ownerRole,
    goal: task.goal,
    ...(task.assignment ? { assignment: task.assignment } : {}),
    execution: task.execution,
    childTaskIds: task.childTaskIds.filter((id) => visibleIds.has(id)),
    plan,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}
function uniqueIds(values: unknown, label: string): string[] { if (!Array.isArray(values) || values.length > 64) throw new Error(`${label} IDs must be an array of at most 64 items.`); const output = values.map((value) => { const id = nonempty(value, `${label} ID`); managedId(id, label); return id; }); if (new Set(output).size !== output.length) throw new Error(`Duplicate ${label} ID.`); return output; }
function validateDirectionReferences(tasks: readonly PersistedTaskV1[], directions: readonly TaskDirectionV1[]): void { const known = new Set(directions.map((direction) => direction.directionId)); for (const task of tasks) for (const revision of task.planRevisions) for (const directionId of revision.directionIds ?? []) if (!known.has(directionId)) throw new Error(`Task plan references unknown user direction: ${directionId}`); }
function boundedList(values: readonly string[], label: string): string[] { if (values.length > 64) throw new Error(`${label} exceeds 64 items.`); return values.map((item) => bounded(item, label, 8_000)); }
function bounded(value: string, label: string, max: number): string { const normalized = value.trim(); if (!normalized || Buffer.byteLength(normalized, "utf8") > max) throw new Error(`${label} must be nonempty and at most ${max} bytes.`); return normalized; }
function managedId(value: string, label: string): void { if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error(`Invalid ${label} ID: ${value}`); }
function nonempty(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be nonempty.`); return value; }
function object(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function serialize(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
