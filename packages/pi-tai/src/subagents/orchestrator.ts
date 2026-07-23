import { randomUUID } from "node:crypto";
import type { AgentDefinition } from "./agents.ts";
import type { ChildLauncher } from "./launcher.ts";
import { normalizeTaskPacket, type TaskPacket } from "./task.ts";
import {
  childReport,
  isResolvedDelegation,
  snapshotAgentDefinition,
  waitForChildren,
  type ChildMessageDelivery,
  type ChildReport,
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
      until?: "next" | "all";
      onProgress?: (records: readonly DelegationRecord[]) => void;
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
    return this.store.update(id, (current) => ({
      ...current,
      execution: {
        phase: report.outcome,
        report: { ...report, reportedAt: new Date().toISOString() },
      },
    }));
  }

  async abandon(id: string): Promise<DelegationRecord> {
    const record = await this.child(id);
    if (record.childPid && isProcessAlive(record.childPid)) {
      try {
        process.kill(record.childPid, "SIGTERM");
      } catch {
        // Process exited between reconciliation and cancellation.
      }
    }
    await this.launcher.cleanup(record);
    return this.store.update(id, (current) => ({
      ...current,
      execution: { phase: "abandoned", reason: "Abandoned by parent." },
    }));
  }

  async cleanupChildControl(id: string): Promise<void> {
    const record = await this.store.get(id);
    if (record) await this.launcher.cleanup(record);
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
