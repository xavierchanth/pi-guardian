import { randomUUID } from "node:crypto";
import type { WorkspaceAttachment, WorkspacePort, WorkspaceTip } from "../workspaces/domain.ts";
import type { AgentDefinition } from "./agents.ts";
import { isManagedChildLogPath, type ChildLauncher } from "./launcher.ts";
import { normalizeTaskPacket, type TaskPacket } from "./task.ts";
import { intrinsicUsage } from "./ui.ts";
import {
  childReport,
  isResolvedDelegation,
  snapshotAgentDefinition,
  waitForChildren,
  type ChildMessageDelivery,
  type ChildReport,
  type ChildStatusReport,
  type DelegatedWorkspaceState,
  type DelegationRecord,
  type DelegationStore,
  type ParentQuestion,
} from "./store.ts";

export interface SpawnChildRequest {
  task: TaskPacket;
  agent: AgentDefinition;
  caller: AgentDefinition;
  parentCwd: string;
  parentSessionId: string;
  parentDelegationId?: string;
  workspace?: WorkspaceAttachment;
}

export class SubagentOrchestrator {
  private readonly store: DelegationStore;
  private readonly launcher: ChildLauncher;

  constructor(options: { store: DelegationStore; launcher: ChildLauncher }) {
    this.store = options.store;
    this.launcher = options.launcher;
  }

  async spawnChild(request: SpawnChildRequest): Promise<DelegationRecord> {
    if (!request.caller.tools.includes("subagent")) {
      throw new Error(`Agent "${request.caller.name}" does not have the subagent tool.`);
    }
    if (!request.caller.allowedChildren.includes(request.agent.name)) {
      throw new Error(
        `Agent "${request.caller.name}" cannot create "${request.agent.name}"; allowed children: ${request.caller.allowedChildren.join(", ") || "none"}.`,
      );
    }
    const task = normalizeTaskPacket(request.task, request.agent.uncertaintyHandling);
    const id = delegationId(task.objective);
    const now = new Date().toISOString();
    const record: DelegationRecord = {
      version: 3,
      id,
      parentSessionId: request.parentSessionId,
      ...(request.parentDelegationId ? { parentDelegationId: request.parentDelegationId } : {}),
      cwd: request.parentCwd,
      task,
      agent: snapshotAgentDefinition(request.agent),
      execution: { phase: "created" },
      ...(request.workspace ? { workspace: { phase: "active", attachment: request.workspace } } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.store.create(record);
    try {
      const launched = await this.launcher.launch(record);
      return await this.store.update(id, (current) => isResolvedDelegation(current)
        ? current
        : {
            ...current,
            execution: { phase: "running" },
            childPid: launched.pid,
            childLogPath: launched.logPath,
            childControlPath: launched.controlPath,
            childPromptPath: launched.promptPath,
          });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.store.update(id, (current) => ({
        ...current,
        execution: {
          phase: "failed",
          report: {
            outcome: "failed",
            summary: message,
            reportedAt: new Date().toISOString(),
          },
        },
      }));
    }
  }

  async children(parentSessionId: string): Promise<DelegationRecord[]> {
    const records = await this.store.listChildren(parentSessionId);
    return Promise.all(records.map((record) => this.reconcileExitedChild(record)));
  }

  async child(id: string): Promise<DelegationRecord> {
    const record = await this.store.get(id);
    if (!record) throw new Error(`Unknown delegation: ${id}`);
    return this.reconcileExitedChild(record);
  }

  async wait(
    parentSessionId: string,
    options: {
      signal?: AbortSignal;
      childIds?: readonly string[];
      onProgress?: (records: readonly DelegationRecord[]) => void | Promise<void>;
    } = {},
  ): Promise<DelegationRecord[]> {
    return waitForChildren(this.store, parentSessionId, options);
  }

  async message(id: string, message: string, delivery: ChildMessageDelivery): Promise<DelegationRecord> {
    const text = message.trim();
    if (!text) throw new Error("Child message must not be empty.");
    const record = await this.child(id);
    if (record.execution.phase !== "running") {
      throw new Error(`Messages can be sent only to a running child; current phase is ${record.execution.phase}.`);
    }
    this.requireLiveProcess(record);
    await this.launcher.message(record, text, delivery);
    return this.store.update(id, (current) => ({
      ...current,
      parentMessages: [
        ...(current.parentMessages ?? []),
        { message: text, delivery, sentAt: new Date().toISOString() },
      ],
    }));
  }

  async respond(id: string, questionId: string, response: string): Promise<DelegationRecord> {
    const text = response.trim();
    if (!text) throw new Error("Parent response must not be empty.");
    const record = await this.child(id);
    if (record.execution.phase !== "awaiting_parent") {
      throw new Error(`Child is not awaiting a parent response; current phase is ${record.execution.phase}.`);
    }
    if (record.execution.question.id !== questionId) {
      throw new Error(`Stale parent question: expected ${record.execution.question.id}, received ${questionId}.`);
    }
    this.requireLiveProcess(record);
    await this.launcher.message(record, `Parent response to ${questionId}: ${text}`, "steer");
    const answeredAt = new Date().toISOString();
    return this.store.update(id, (current) => {
      if (current.execution.phase !== "awaiting_parent" || current.execution.question.id !== questionId) {
        throw new Error("Parent question changed before the response was recorded.");
      }
      return {
        ...current,
        execution: { phase: "running" },
        answeredQuestions: [
          ...(current.answeredQuestions ?? []),
          { ...current.execution.question, response: text, answeredAt },
        ],
        parentMessages: [
          ...(current.parentMessages ?? []),
          { message: text, delivery: "steer", questionId, sentAt: answeredAt },
        ],
      };
    });
  }

  async askParent(
    id: string,
    question: Omit<ParentQuestion, "id" | "askedAt">,
  ): Promise<DelegationRecord> {
    const record = await this.child(id);
    if (record.execution.phase !== "running") {
      throw new Error(`Only a running child can ask its parent; current phase is ${record.execution.phase}.`);
    }
    const prompt = question.question.trim();
    if (!prompt) throw new Error("Parent question must not be empty.");
    return this.store.update(id, (current) => ({
      ...current,
      execution: {
        phase: "awaiting_parent",
        question: {
          id: `question-${randomUUID()}`,
          question: prompt,
          ...(question.options?.length ? { options: question.options.map((value) => value.trim()) } : {}),
          ...(question.recommendation?.trim() ? { recommendation: question.recommendation.trim() } : {}),
          ...(question.consequences?.length
            ? { consequences: question.consequences.map((value) => value.trim()) }
            : {}),
          askedAt: new Date().toISOString(),
        },
      },
    }));
  }

  async attachChildSession(id: string, session: { id: string; file?: string }): Promise<DelegationRecord> {
    return this.store.update(id, (record) => ({
      ...record,
      childSessionId: session.id,
      ...(session.file ? { childSessionFile: session.file } : {}),
    }));
  }

  async report(
    id: string,
    report: Omit<ChildReport, "reportedAt">,
  ): Promise<DelegationRecord> {
    const record = await this.child(id);
    if (isResolvedDelegation(record)) {
      const existing = childReport(record);
      if (existing) return record;
      throw new Error(`Delegation is already resolved: ${record.execution.phase}`);
    }
    const directChildren = (await this.store.list()).filter((candidate) => candidate.parentDelegationId === id);
    const outstanding = directChildren.filter((candidate) => !isResolvedDelegation(candidate) || !candidate.parentCollectedAt);
    if (outstanding.length > 0) {
      throw new Error(`Collect all ${outstanding.length} outstanding direct child result(s) before reporting to the parent.`);
    }
    return this.store.update(id, (current) => ({
      ...current,
      execution: {
        phase: report.outcome,
        report: { ...report, reportedAt: new Date().toISOString() },
      },
    }));
  }

  async settle(id: string, summary: string): Promise<DelegationRecord> {
    const record = await this.child(id);
    if (isResolvedDelegation(record) || record.execution.phase === "awaiting_parent") return record;
    const descendants = (await this.store.list()).filter((candidate) => candidate.parentDelegationId === id);
    if (descendants.some((candidate) => !isResolvedDelegation(candidate) || !candidate.parentCollectedAt)) return record;
    return this.report(id, {
      outcome: "completed",
      summary: summary.trim() || "Child agent settled without an explicit report.",
    });
  }

  async attributeUsage(id: string): Promise<DelegationRecord> {
    const attributedAt = new Date().toISOString();
    return this.store.update(id, (current) => ({
      ...current,
      usageAttributedAt: current.usageAttributedAt ?? attributedAt,
    }));
  }

  async all(): Promise<DelegationRecord[]> {
    return this.store.list();
  }

  async reportStatus(id: string, report: Omit<ChildStatusReport, "reportedAt">): Promise<DelegationRecord> {
    const record = await this.child(id);
    if (isResolvedDelegation(record)) return record;
    const summary = report.summary.trim();
    if (!report.requestId.trim() || !summary) throw new Error("Status reports require a request ID and summary.");
    return this.store.update(id, (current) => ({
      ...current,
      statusReports: [
        ...(current.statusReports ?? []).filter((candidate) => candidate.requestId !== report.requestId),
        { ...report, summary, reportedAt: new Date().toISOString() },
      ],
    }));
  }

  async collectStatus(parentSessionId: string, timeoutMs = 30_000): Promise<{
    requestId: string;
    records: DelegationRecord[];
    timedOutIds: string[];
  }> {
    const requestId = `status-${randomUUID()}`;
    const initial = await this.store.list();
    const selected = delegationDescendants(initial, parentSessionId).filter((record) => !isResolvedDelegation(record));
    const deadline = Date.now() + timeoutMs;
    const prompt = [
      `Status request ${requestId}.`,
      "Pause only long enough to report a concise factual snapshot with report_status, then continue your prior work.",
      "If you own unresolved children, return to wait_for_children after reporting.",
    ].join(" ");
    await Promise.all(selected.map(async (record) => {
      if (record.execution.phase !== "running") return;
      this.requireLiveProcess(record);
      await this.launcher.message(record, prompt, "steer");
      await this.store.update(record.id, (current) => ({
        ...current,
        parentMessages: [...(current.parentMessages ?? []), { message: prompt, delivery: "steer", sentAt: new Date().toISOString() }],
      }));
    }));
    while (Date.now() < deadline) {
      const current = (await Promise.all(selected.map((record) => this.store.get(record.id))))
        .filter((record): record is DelegationRecord => Boolean(record));
      if (current.every((record) => isResolvedDelegation(record) || record.statusReports?.some((report) => report.requestId === requestId))) {
        return { requestId, records: current, timedOutIds: [] };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const records = (await Promise.all(selected.map((record) => this.store.get(record.id))))
      .filter((record): record is DelegationRecord => Boolean(record));
    return {
      requestId,
      records,
      timedOutIds: records.filter((record) => !isResolvedDelegation(record) && !record.statusReports?.some((report) => report.requestId === requestId)).map((record) => record.id),
    };
  }

  async abandon(id: string): Promise<DelegationRecord> {
    const abandoned = await this.abandonTree(id);
    const root = abandoned.find((record) => record.id === id) ?? await this.child(id);
    return root;
  }

  async forceAbandonChildren(parentSessionId: string): Promise<DelegationRecord[]> {
    const records = await this.store.list();
    const direct = records.filter((record) =>
      record.parentSessionId === parentSessionId
      && (!isResolvedDelegation(record) || record.execution.phase === "abandoned")
    );
    const abandoned: DelegationRecord[] = [];
    const seen = new Set<string>();
    for (const record of direct) {
      for (const candidate of await this.abandonTree(record.id)) {
        if (candidate.execution.phase !== "abandoned" || seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        abandoned.push(candidate);
      }
    }
    return abandoned;
  }

  async integrateWorkspace(id: string, workspace: WorkspacePort): Promise<DelegationRecord> {
    const record = await this.child(id);
    const state = requireWorkspacePhase(record, "active");
    if (record.execution.phase !== "completed") {
      throw new Error(`Implementation Lead workspace integration requires a completed child; current phase is ${record.execution.phase}.`);
    }
    const tip = await workspace.captureTip(state.attachment);
    try {
      const integrated = await workspace.integrate(state.attachment);
      if (integrated.conflicted) {
        const reason = `Workspace integration produced conflicts: ${integrated.conflictFiles.join(", ") || "unknown paths"}.`;
        await this.stopWorkspaceIntegration(id, state.attachment, tip, integrated.workspaceRemoved, reason);
        throw new Error(`${reason} Stop and ask the user to inspect JJ history; do not attempt repair.`);
      }
      return this.store.update(id, (current) => ({
        ...current,
        workspace: {
          phase: "integrated",
          attachment: state.attachment,
          tip,
          result: integrated,
          integratedAt: new Date().toISOString(),
        },
      }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const current = await this.store.get(id);
      if (current?.workspace?.phase !== "attention_required") {
        const workspaceRemoved = Boolean((error as { workspaceRemoved?: unknown })?.workspaceRemoved);
        await this.stopWorkspaceIntegration(id, state.attachment, tip, workspaceRemoved, reason);
      }
      throw new Error(`Workspace integration stopped: ${reason} Inspect the JJ operation log and ask the user to intervene.`);
    }
  }

  async describeWorkspaceChanges(
    id: string,
    workspace: WorkspacePort,
    descriptions: readonly { changeId: string; description: string }[],
  ): Promise<DelegationRecord> {
    const record = await this.child(id);
    const state = requireWorkspacePhase(record, "integrated");
    const integrated = new Set(state.result.integratedChangeIds);
    if (descriptions.some((change) => !integrated.has(change.changeId))) {
      throw new Error("Descriptions may target only changes integrated from this workspace.");
    }
    const remaining = await workspace.describe(state.attachment, descriptions);
    const describedIds = new Set(descriptions.map((change) => change.changeId));
    const undescribedChangeIds = [
      ...state.result.undescribedChangeIds.filter((changeId) => !describedIds.has(changeId)),
      ...remaining,
    ].filter((changeId, index, values) => values.indexOf(changeId) === index);
    return this.store.update(id, (current) => ({
      ...current,
      workspace: { ...state, result: { ...state.result, undescribedChangeIds } },
    }));
  }

  async cleanupChildControl(id: string): Promise<void> {
    const record = await this.store.get(id);
    if (record) await this.launcher.cleanup(record);
  }

  private async abandonTree(id: string): Promise<DelegationRecord[]> {
    const root = await this.child(id);
    if (isResolvedDelegation(root) && root.execution.phase !== "abandoned") return [root];

    const records = await this.store.list();
    const selectedIds = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of records) {
        if (record.parentDelegationId && selectedIds.has(record.parentDelegationId) && !selectedIds.has(record.id)) {
          selectedIds.add(record.id);
          changed = true;
        }
      }
    }
    const byId = new Map(records.map((record) => [record.id, record]));
    byId.set(root.id, root);
    const depth = (record: DelegationRecord): number => {
      let value = 0;
      let parent = record.parentDelegationId;
      const seen = new Set<string>();
      while (parent && !seen.has(parent)) {
        seen.add(parent);
        const ancestor = byId.get(parent);
        if (!ancestor) break;
        value += 1;
        parent = ancestor.parentDelegationId;
      }
      return value;
    };
    const selected = [...byId.values()]
      .filter((record) => selectedIds.has(record.id))
      .sort((left, right) => depth(right) - depth(left));
    const abandoned: DelegationRecord[] = [];
    for (const selectedRecord of selected) {
      const current = await this.store.get(selectedRecord.id);
      if (!current || (isResolvedDelegation(current) && current.execution.phase !== "abandoned")) continue;
      let durable = current.execution.phase === "abandoned"
        ? current
        : await this.store.update(current.id, (latest) => isResolvedDelegation(latest)
          ? latest
          : {
              ...latest,
              execution: { phase: "abandoned", reason: "Abandoned by parent." },
            });
      if (durable.execution.phase !== "abandoned") continue;
      await terminateProcess(durable.childPid);
      if (!durable.intrinsicUsage) {
        const managedLogPath = this.store.root
          && await isManagedChildLogPath(this.store.root, durable.id, durable.childLogPath)
          ? durable.childLogPath
          : undefined;
        const usage = await intrinsicUsage(managedLogPath);
        durable = await this.store.update(durable.id, (latest) => ({
          ...latest,
          intrinsicUsage: latest.intrinsicUsage ?? usage,
        }));
      }
      await this.launcher.cleanup(durable, { runtimeArtifacts: true });
      abandoned.push(durable);
    }
    return abandoned;
  }

  private async stopWorkspaceIntegration(
    id: string,
    attachment: WorkspaceAttachment,
    tip: WorkspaceTip,
    workspaceRemoved: boolean,
    reason: string,
  ): Promise<DelegationRecord> {
    return this.store.update(id, (current) => ({
      ...current,
      workspace: {
        phase: "attention_required",
        attachment,
        operation: "integration",
        tip,
        workspaceRemoved,
        reason,
        stoppedAt: new Date().toISOString(),
      },
    }));
  }

  private requireLiveProcess(record: DelegationRecord): void {
    if (!record.childPid || !isProcessAlive(record.childPid)) {
      throw new Error("Child process is not running.");
    }
  }

  private async reconcileExitedChild(record: DelegationRecord): Promise<DelegationRecord> {
    if (isResolvedDelegation(record) || !record.childPid || isProcessAlive(record.childPid)) return record;
    await this.launcher.cleanup(record);
    return this.store.update(record.id, (current) => isResolvedDelegation(current)
      ? current
      : {
          ...current,
          execution: {
            phase: "failed",
            report: {
              outcome: "failed",
              summary: "Child process exited without reporting.",
              reportedAt: new Date().toISOString(),
            },
          },
        });
  }
}

function requireWorkspacePhase<P extends DelegatedWorkspaceState["phase"]>(
  record: DelegationRecord,
  phase: P,
): Extract<DelegatedWorkspaceState, { phase: P }> {
  const state = record.workspace;
  if (!state) throw new Error(`Delegation ${record.id} does not own a workspace.`);
  if (state.phase === "attention_required") {
    throw new Error(
      `Workspace ${state.attachment.name} requires user attention after ${state.operation}: ${state.reason}`,
    );
  }
  if (state.phase !== phase) {
    throw new Error(`Workspace operation requires phase ${phase}; current phase is ${state.phase}.`);
  }
  return state as Extract<DelegatedWorkspaceState, { phase: P }>;
}

function delegationDescendants(records: readonly DelegationRecord[], parentSessionId: string): DelegationRecord[] {
  const selected = new Set(records.filter((record) => record.parentSessionId === parentSessionId).map((record) => record.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (record.parentDelegationId && selected.has(record.parentDelegationId) && !selected.has(record.id)) {
        selected.add(record.id);
        changed = true;
      }
    }
  }
  return records.filter((record) => selected.has(record.id));
}

function delegationId(objective: string): string {
  const slug = objective.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30) || "task";
  return `${slug}-${randomUUID().slice(0, 8)}`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcess(pid: number | undefined): Promise<void> {
  if (!pid || !isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 1_000;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Process exited after the final liveness check.
  }
}
