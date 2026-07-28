import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HostConcurrencyState } from "./host-state.ts";

export type TaskOwnerRole = "orchestrator" | "implementation-lead" | "documenter" | "worker" | "reviewer" | "scout" | "researcher";
export interface UserMessageEvidenceV1 { readonly messageId: string; readonly contentHash: string; readonly content: string; readonly observedAt: string; }
export interface TaskDirectionV1 { readonly directionId: string; readonly evidence: UserMessageEvidenceV1; readonly summary: string; readonly recordedByContextId: string; readonly recordedAt: string; }
export interface TaskPlanRevisionV1 { readonly revisionId: string; readonly authorContextId: string; readonly authorRole: "orchestrator" | "implementation-lead"; readonly authorityMessageId?: string; readonly markdown: string; readonly rationale: string; readonly directionIds?: readonly string[]; readonly recordedAt: string; readonly workspaceOperationId?: string; }
export interface TaskPlanApprovalV1 { readonly approvalId: string; readonly planRevisionId: string; readonly planDigest: string; readonly directionCount: number; readonly evidence: UserMessageEvidenceV1; readonly approvedByContextId: string; readonly approvedAt: string; }
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
  readonly assignment?: { readonly objective: string; readonly acceptanceCriteria: readonly string[]; readonly constraints: readonly string[]; readonly approvalId?: string };
  readonly execution: TaskExecutionBindingV1;
  readonly childTaskIds: readonly string[];
  readonly directions: readonly TaskDirectionV1[];
  readonly planRevisions: readonly TaskPlanRevisionV1[];
  readonly approvals: readonly TaskPlanApprovalV1[];
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
  readonly currentApproval?: TaskPlanApprovalV1;
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
  async createRoot(input: { rootSessionId: string; orchestratorContextId: string; objective: string; acceptanceCriteria?: readonly string[]; constraints?: readonly string[]; userRequest: UserMessageEvidenceV1 }): Promise<PersistedTaskV1> { const at = this.now(); const record: PersistedTaskV1 = { version: 1, taskId: `task-${randomUUID()}`, rootSessionId: input.rootSessionId, ownerRole: "orchestrator", createdByContextId: input.orchestratorContextId, goal: { objective: bounded(input.objective, "objective", 16_000), acceptanceCriteria: boundedList(input.acceptanceCriteria ?? [], "acceptance criteria"), constraints: boundedList(input.constraints ?? [], "constraints"), userRequest: validateEvidence(input.userRequest) }, execution: { phase: "root", rootSessionId: input.rootSessionId }, childTaskIds: [], directions: [], planRevisions: [], approvals: [], createdAt: at, updatedAt: at }; await this.store.create(record); return record; }
  async assign(parentTaskId: string, input: { ownerRole: Exclude<TaskOwnerRole, "orchestrator">; creatorContextId: string; objective: string; acceptanceCriteria?: readonly string[]; constraints?: readonly string[] }): Promise<PersistedTaskV1> { const parent = await this.require(parentTaskId); const at = this.now(); const approval = input.ownerRole === "implementation-lead" || input.ownerRole === "documenter" ? await this.requireCurrentApproval(parentTaskId) : undefined; const child: PersistedTaskV1 = { version: 1, taskId: `task-${randomUUID()}`, rootSessionId: parent.rootSessionId, parentTaskId, ownerRole: input.ownerRole, createdByContextId: input.creatorContextId, goal: parent.goal, assignment: { objective: bounded(input.objective, "assignment objective", 16_000), acceptanceCriteria: boundedList(input.acceptanceCriteria ?? [], "assignment acceptance criteria"), constraints: boundedList(input.constraints ?? [], "assignment constraints"), ...(approval ? { approvalId: approval.approvalId } : {}) }, execution: { phase: "unassigned" }, childTaskIds: [], directions: [], planRevisions: [], approvals: [], createdAt: at, updatedAt: at }; await this.store.create(child); await this.store.update(parentTaskId, (record) => ({ ...record, childTaskIds: [...record.childTaskIds, child.taskId], updatedAt: at })); return child; }
  async bind(taskId: string, contextId: string): Promise<PersistedTaskV1> { return this.store.update(taskId, (record) => { if (record.execution.phase !== "unassigned") throw new Error("Task execution is already bound."); return { ...record, execution: { phase: "bound", contextId }, updatedAt: this.now() }; }); }
  async appendPlan(taskId: string, input: { authorContextId: string; authorRole: "orchestrator" | "implementation-lead"; authorityMessageId?: string; markdown: string; rationale: string; directionIds?: readonly string[]; workspaceOperationId?: string }): Promise<PersistedTaskV1> {
    const root = await this.rootOf(taskId);
    const knownDirections = new Set(root.directions.map((direction) => direction.directionId));
    const directionIds = uniqueIds(input.directionIds ?? [], "direction");
    for (const directionId of directionIds) if (!knownDirections.has(directionId)) throw new Error(`Unknown user direction: ${directionId}`);
    return this.store.update(taskId, (record) => {
      if (record.ownerRole !== input.authorRole) throw new Error("Only the owning orchestrator or implementation-lead may revise this task plan.");
      if (record.execution.phase === "bound" && record.execution.contextId !== input.authorContextId) throw new Error("Plan author does not own the bound task context.");
      if (input.authorRole === "orchestrator" && !input.authorityMessageId) throw new Error("Orchestrator plan revisions require the latest user message authority.");
      const revision: TaskPlanRevisionV1 = {
        revisionId: `plan-${randomUUID()}`,
        authorContextId: input.authorContextId,
        authorRole: input.authorRole,
        ...(input.authorityMessageId ? { authorityMessageId: input.authorityMessageId } : {}),
        markdown: bounded(input.markdown, "plan markdown", 64_000),
        rationale: bounded(input.rationale, "plan rationale", 8_000),
        ...(directionIds.length ? { directionIds } : {}),
        recordedAt: this.now(),
        ...(input.workspaceOperationId ? { workspaceOperationId: input.workspaceOperationId } : {}),
      };
      return { ...record, planRevisions: [...record.planRevisions, revision], updatedAt: revision.recordedAt };
    });
  }
  async recordDirection(taskId: string, input: { orchestratorContextId: string; evidence: UserMessageEvidenceV1; summary: string }): Promise<PersistedTaskV1> { return this.store.update(taskId, (record) => { if (record.ownerRole !== "orchestrator" && record.parentTaskId !== undefined) throw new Error("User direction must be attached through the root orchestrator task."); const at = this.now(); const direction: TaskDirectionV1 = { directionId: `direction-${randomUUID()}`, evidence: validateEvidence(input.evidence), summary: bounded(input.summary, "direction summary", 8_000), recordedByContextId: input.orchestratorContextId, recordedAt: at }; return { ...record, directions: [...record.directions, direction], updatedAt: at }; }); }
  async approvePlan(taskId: string, input: { orchestratorContextId: string; evidence: UserMessageEvidenceV1 }): Promise<TaskPlanApprovalV1> { let approval!: TaskPlanApprovalV1; await this.store.update(taskId, (record) => { if (record.ownerRole !== "orchestrator" || record.parentTaskId !== undefined) throw new Error("Only the root Orchestrator plan may be approved."); const revision = record.planRevisions.at(-1); if (!revision) throw new Error("A current plan is required before approval."); const evidence = validateEvidence(input.evidence); const priorAuthorityMessages = new Set([record.goal.userRequest.messageId, revision.authorityMessageId, ...record.directions.map((direction) => direction.evidence.messageId), ...record.approvals.map((item) => item.evidence.messageId)].filter((item): item is string => Boolean(item))); if (priorAuthorityMessages.has(evidence.messageId)) throw new Error("Plan approval requires a distinct subsequent user message explicitly approving the current plan."); if (!expressesPlanApproval(evidence.content)) throw new Error("The user message does not explicitly approve proceeding with the current plan."); const referencedRevisionId = referencedPlanRevision(evidence.content); if (referencedRevisionId && referencedRevisionId !== revision.revisionId) throw new Error("The user approved a different plan revision; request approval for the current plan."); approval = { approvalId: `approval-${randomUUID()}`, planRevisionId: revision.revisionId, planDigest: createHash("sha256").update(revision.markdown).digest("hex"), directionCount: record.directions.length, evidence, approvedByContextId: input.orchestratorContextId, approvedAt: this.now() }; return { ...record, approvals: [...record.approvals, approval], updatedAt: approval.approvedAt }; }); return approval; }
  async currentApproval(taskId: string): Promise<TaskPlanApprovalV1 | undefined> { const root = await this.rootOf(taskId); const revision = root.planRevisions.at(-1); const approval = root.approvals.at(-1); return revision && approval?.planRevisionId === revision.revisionId && approval.planDigest === createHash("sha256").update(revision.markdown).digest("hex") && approval.directionCount === root.directions.length ? approval : undefined; }
  async requireCurrentApproval(taskId: string): Promise<TaskPlanApprovalV1> { const approval = await this.currentApproval(taskId); if (!approval) throw new Error("Implementation requires explicit user approval of the current Orchestrator plan."); return approval; }
  async requireAssignmentApproval(taskId: string): Promise<TaskPlanApprovalV1> { const task = await this.require(taskId); const approval = await this.requireCurrentApproval(taskId); if (task.assignment?.approvalId !== approval.approvalId) throw new Error("Workspace task approval is stale; create a new assignment from the currently approved plan."); return approval; }
  async requireCurrentImplementationApproval(taskId: string): Promise<TaskPlanApprovalV1 | undefined> { const task = await this.require(taskId); return task.ownerRole === "implementation-lead" || task.ownerRole === "documenter" || task.ownerRole === "worker" ? this.requireCurrentApproval(taskId) : undefined; }
  async snapshot(taskId: string): Promise<TaskSnapshotReceipt> { const rootTask = await this.rootOf(taskId); const tree = (await this.tree(rootTask.taskId)).filter((task) => task.ownerRole !== "reviewer"); validateDirectionReferences(tree, rootTask.directions); const markdown = renderTaskSnapshot(tree); const content = Buffer.from(markdown, "utf8"); const digest = createHash("sha256").update(content).digest("hex"); const directory = resolve(this.artifactRoot, taskId); const root = resolve(this.artifactRoot); if (directory !== join(root, taskId)) throw new Error("Task snapshot path escaped its managed root."); await mkdir(directory, { recursive: true, mode: 0o700 }); const path = join(directory, `${digest}.md`); try { await writeFile(path, content, { mode: 0o600, flag: "wx" }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } return { snapshotId: `snapshot-${digest}`, taskId, digest, path, bytes: content.byteLength, createdAt: this.now() }; }
  async status(taskId: string, viewerRole: TaskOwnerRole): Promise<TaskStatusProjectionV1> {
    const focus = await this.require(taskId);
    const root = await this.rootOf(taskId);
    const full = viewerRole === "orchestrator" || viewerRole === "reviewer";
    const completeTree = await this.tree(root.taskId);
    validateDirectionReferences(completeTree, root.directions);
    const selected = full
      ? completeTree
      : viewerRole === "implementation-lead"
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
  input.ownerRole = canonicalTaskRole(input.ownerRole);
  input.approvals ??= [];
  if (Array.isArray(input.planRevisions)) for (const revision of input.planRevisions) if (object(revision)) revision.authorRole = canonicalPlanRole(revision.authorRole);
  for (const key of ["taskId", "rootSessionId", "createdByContextId"] as const) managedId(nonempty(input[key], key), key);
  if (input.parentTaskId !== undefined) managedId(nonempty(input.parentTaskId, "parentTaskId"), "parent task");
  if (!["orchestrator", "implementation-lead", "documenter", "worker", "reviewer", "scout", "researcher"].includes(String(input.ownerRole))) throw new Error("Invalid task owner role.");
  if (!object(input.goal)) throw new Error("Task goal is required.");
  bounded(nonempty(input.goal.objective, "goal objective"), "goal objective", 16_000);
  if (!Array.isArray(input.goal.acceptanceCriteria) || !Array.isArray(input.goal.constraints)) throw new Error("Task goal lists are required.");
  validateEvidence(input.goal.userRequest);
  if (input.assignment !== undefined && !object(input.assignment)) throw new Error("Task assignment is invalid.");
  if (!object(input.execution) || !["unassigned", "bound", "root"].includes(String(input.execution.phase))) throw new Error("Task execution binding is invalid.");
  if (input.execution.phase === "bound") managedId(nonempty(input.execution.contextId, "execution context"), "context");
  if (!Array.isArray(input.childTaskIds) || !Array.isArray(input.directions) || !Array.isArray(input.planRevisions) || !Array.isArray(input.approvals)) throw new Error("Task collections are required.");
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
  if (input.planRevisions.length && input.ownerRole !== "orchestrator" && input.ownerRole !== "implementation-lead") throw new Error("Only orchestrator and implementation-lead tasks may contain plan revisions.");
  const approvals = new Set<string>();
  for (const approval of input.approvals) { validateApproval(approval); if (approvals.has(approval.approvalId)) throw new Error("Duplicate task plan approval."); approvals.add(approval.approvalId); if (!input.planRevisions.some((revision: TaskPlanRevisionV1) => revision.revisionId === approval.planRevisionId)) throw new Error("Task approval references an unknown plan revision."); }
  if (input.approvals.length && (input.ownerRole !== "orchestrator" || input.parentTaskId !== undefined)) throw new Error("Only the root Orchestrator task may contain approvals.");
  if (input.assignment?.approvalId !== undefined) managedId(nonempty(input.assignment.approvalId, "assignment approval"), "approval");
  nonempty(input.createdAt, "createdAt");
  nonempty(input.updatedAt, "updatedAt");
  return input as unknown as PersistedTaskV1;
}
function assertImmutableTask(before: PersistedTaskV1, after: PersistedTaskV1): void { for (const key of ["taskId", "rootSessionId", "parentTaskId", "ownerRole", "createdByContextId", "createdAt"] as const) if (before[key] !== after[key]) throw new Error(`Task update cannot change immutable ${key}.`); if (JSON.stringify(before.goal) !== JSON.stringify(after.goal) || JSON.stringify(before.assignment) !== JSON.stringify(after.assignment)) throw new Error("Task update cannot rewrite goal or assignment."); if (after.directions.length < before.directions.length || JSON.stringify(after.directions.slice(0, before.directions.length)) !== JSON.stringify(before.directions)) throw new Error("Task directions are append-only."); if (after.planRevisions.length < before.planRevisions.length || JSON.stringify(after.planRevisions.slice(0, before.planRevisions.length)) !== JSON.stringify(before.planRevisions)) throw new Error("Task plan revisions are append-only."); if (after.approvals.length < before.approvals.length || JSON.stringify(after.approvals.slice(0, before.approvals.length)) !== JSON.stringify(before.approvals)) throw new Error("Task approvals are append-only."); }
function validateEvidence(value: unknown): UserMessageEvidenceV1 { if (!object(value)) throw new Error("User message evidence is required."); managedId(nonempty(value.messageId, "user message ID"), "user message"); const content = bounded(nonempty(value.content, "user message content"), "user message content", 64_000); const hash = nonempty(value.contentHash, "user content hash"); if (hash !== createHash("sha256").update(content).digest("hex")) throw new Error("User message evidence hash mismatch."); nonempty(value.observedAt, "user message observedAt"); return value as unknown as UserMessageEvidenceV1; }
function validateDirection(value: unknown): void { if (!object(value)) throw new Error("Task direction is invalid."); managedId(nonempty(value.directionId, "direction ID"), "direction"); validateEvidence(value.evidence); bounded(nonempty(value.summary, "direction summary"), "direction summary", 8_000); managedId(nonempty(value.recordedByContextId, "direction context"), "context"); nonempty(value.recordedAt, "direction recordedAt"); }
function validateApproval(value: unknown): void { if (!object(value)) throw new Error("Task approval is invalid."); managedId(nonempty(value.approvalId, "approval ID"), "approval"); managedId(nonempty(value.planRevisionId, "approved plan revision"), "plan revision"); if (!/^[a-f0-9]{64}$/.test(nonempty(value.planDigest, "approved plan digest"))) throw new Error("Invalid approved plan digest."); if (!Number.isSafeInteger(value.directionCount) || value.directionCount < 0) throw new Error("Invalid approved direction count."); validateEvidence(value.evidence); managedId(nonempty(value.approvedByContextId, "approving context"), "context"); nonempty(value.approvedAt, "approvedAt"); }
function validateRevision(value: unknown): void { if (!object(value)) throw new Error("Task plan revision is invalid."); managedId(nonempty(value.revisionId, "revision ID"), "plan revision"); managedId(nonempty(value.authorContextId, "plan author"), "context"); if (value.authorityMessageId !== undefined) managedId(nonempty(value.authorityMessageId, "plan authority message"), "user message"); if (!["orchestrator", "implementation-lead"].includes(String(value.authorRole))) throw new Error("Invalid plan author role."); bounded(nonempty(value.markdown, "plan markdown"), "plan markdown", 64_000); bounded(nonempty(value.rationale, "plan rationale"), "plan rationale", 8_000); if (value.directionIds !== undefined) uniqueIds(value.directionIds, "direction"); nonempty(value.recordedAt, "plan recordedAt"); }
function renderTaskSnapshot(tasks: readonly PersistedTaskV1[]): string { return tasks.map((task, index) => { const current = task.planRevisions.at(-1)?.revisionId; return [`${"#".repeat(Math.min(index + 1, 6))} Task ${task.taskId}`, `Owner: ${task.ownerRole}`, `Goal: ${task.goal.objective}`, ...(task.assignment ? [`Assignment: ${task.assignment.objective}`] : []), ...task.directions.map((item) => `Direction ${item.directionId} (${item.evidence.messageId}): ${item.summary}\n\n${item.evidence.content}`), ...task.planRevisions.map((item) => `${item.revisionId === current ? "Current" : "Superseded"} plan revision ${item.revisionId} (${item.authorRole})${item.directionIds?.length ? `\nDirections: ${item.directionIds.join(", ")}` : ""}:\n\n${item.markdown}\n\nRationale: ${item.rationale}`), ...task.approvals.map((item) => `Approved plan ${item.planRevisionId} (${item.approvalId})\nDigest: ${item.planDigest}\nDirections: ${item.directionCount}\nUser evidence: ${item.evidence.messageId}\nApproved at: ${item.approvedAt}`)].join("\n\n"); }).join("\n\n"); }
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
    ...(task.ownerRole === "orchestrator" && current && task.approvals.at(-1)?.planRevisionId === current.revisionId && task.approvals.at(-1)?.planDigest === createHash("sha256").update(current.markdown).digest("hex") && task.approvals.at(-1)?.directionCount === task.directions.length ? { currentApproval: task.approvals.at(-1) } : {}),
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
function expressesPlanApproval(content: string): boolean {
  const normalized = content.toLowerCase().replace(/\s+/g, " ").trim();
  const explicit = [
    /^i approve this plan: plan-[a-z0-9_-]+[.!]?$/,
    /^(?:i )?approve(?: this| the)? plan[.!]?$/,
    /^approved[.!]?$/,
    /^approved[,; ]+go ahead[.!]?$/,
    /^(?:please )?proceed[.!]?$/,
    /^go ahead(?: and implement)?[.!]?$/,
    /^ship it[.!]?$/,
    /^implement (?:it|this|the plan)[.!]?$/,
    /^yes[,; ]+(?:proceed|go ahead|implement (?:it|this|the plan))[.!]?$/,
    /^(?:ok|okay)(?:,| that seems good| looks good)?[.! ]+go ahead(?: and implement)?[.!]?$/,
  ];
  return explicit.some((pattern) => pattern.test(normalized));
}
function referencedPlanRevision(content: string): string | undefined {
  return content.trim().match(/^I approve this plan: (plan-[a-zA-Z0-9_-]+)[.!]?$/i)?.[1];
}
function canonicalTaskRole(value: unknown): TaskOwnerRole { if (value === "thinker") return "orchestrator"; if (value === "planner") return "implementation-lead"; return String(value) as TaskOwnerRole; }
function canonicalPlanRole(value: unknown): TaskPlanRevisionV1["authorRole"] { if (value === "thinker") return "orchestrator"; if (value === "planner") return "implementation-lead"; return String(value) as TaskPlanRevisionV1["authorRole"]; }
function serialize(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
