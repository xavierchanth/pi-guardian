import { randomUUID } from "node:crypto";
import type { ModelPreference } from "./domain.ts";
import { DEFAULT_MODEL_PREFERENCES } from "./domain.ts";
import type { ChildLauncher } from "./launcher.ts";
import type { WorkspacePort } from "../workspaces/domain.ts";
import {
  isResolvedDelegation,
  waitForChildren,
  type ChildMessageDelivery,
  type ChildReport,
  type DelegationRecord,
  type DelegationStore,
} from "./store.ts";

export interface SpawnChildRequest {
  task: string;
  modelPreferenceId: string;
  parentCwd: string;
  parentSessionId: string;
  parentSessionFile?: string;
}

export class SubagentOrchestrator {
  private readonly store: DelegationStore;
  private readonly workspace: WorkspacePort;
  private readonly launcher: ChildLauncher;
  private readonly preferences: readonly ModelPreference[];

  constructor(options: {
    store: DelegationStore;
    workspace: WorkspacePort;
    launcher: ChildLauncher;
    preferences?: readonly ModelPreference[];
  }) {
    this.store = options.store;
    this.workspace = options.workspace;
    this.launcher = options.launcher;
    this.preferences = options.preferences ?? DEFAULT_MODEL_PREFERENCES;
  }

  async spawnChild(request: SpawnChildRequest): Promise<DelegationRecord> {
    const task = request.task.trim();
    if (!task) throw new Error("Child task must not be empty.");
    const preference = this.preferences.find((entry) => entry.id === request.modelPreferenceId);
    if (!preference) throw new Error(`Unknown model preference: ${request.modelPreferenceId}`);
    const id = delegationId(task);
    const workspace = await this.workspace.create({
      cwd: request.parentCwd,
      name: id,
      purpose: "delegation",
    });
    const now = new Date().toISOString();
    const record: DelegationRecord = {
      version: 2,
      id,
      state: "created",
      task,
      modelPreferenceId: preference.id,
      parentSessionId: request.parentSessionId,
      ...(request.parentSessionFile ? { parentSessionFile: request.parentSessionFile } : {}),
      workspace,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.create(record);
    try {
      const launched = await this.launcher.launch(record, preference);
      return await this.store.update(id, (current) => ({
        ...current,
        ...(isResolvedDelegation(current) ? {} : { state: "running" as const }),
        childPid: launched.pid,
        childLogPath: launched.logPath,
        childControlPath: launched.controlPath,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.store.update(id, (current) => ({
        ...current,
        state: "failed",
        report: { outcome: "failed", summary: message, reportedAt: new Date().toISOString() },
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
      onProgress?: (records: readonly DelegationRecord[]) => void;
    } = {},
  ): Promise<DelegationRecord[]> {
    return waitForChildren(this.store, parentSessionId, {
      signal: options.signal,
      onProgress: options.onProgress,
    });
  }

  async message(id: string, message: string, delivery: ChildMessageDelivery): Promise<DelegationRecord> {
    const text = message.trim();
    if (!text) throw new Error("Child message must not be empty.");
    const record = await this.child(id);
    if (record.state !== "running") {
      throw new Error(`Messages can be sent only to a running child; current state is ${record.state}.`);
    }
    if (!record.childPid || !isProcessAlive(record.childPid)) {
      throw new Error("Child process is not running.");
    }
    await this.launcher.message(record, text, delivery);
    return this.store.update(id, (current) => ({
      ...current,
      parentMessages: [
        ...(current.parentMessages ?? []),
        { message: text, delivery, sentAt: new Date().toISOString() },
      ],
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
    report: Omit<ChildReport, "reportedAt" | "childTipId" | "childTipChangeId">,
  ): Promise<DelegationRecord> {
    const record = await this.child(id);
    if (isResolvedDelegation(record)) {
      if (record.report) return record;
      throw new Error(`Delegation is already resolved: ${record.state}`);
    }
    const tip = await this.workspace.captureTip(record.workspace);
    if (record.workspace.backend === "git" && !tip.clean) {
      throw new Error("Git child must commit or otherwise clean its worktree before reporting.");
    }
    return this.store.update(id, (current) => ({
      ...current,
      state: report.outcome,
      report: {
        ...report,
        childTipId: tip.id,
        ...(record.workspace.backend === "jj" ? { childTipChangeId: tip.id } : {}),
        reportedAt: new Date().toISOString(),
      },
    }));
  }

  async integrate(id: string, finalize = false): Promise<DelegationRecord> {
    const record = await this.child(id);
    if (finalize) {
      if (record.state !== "integrated_pending_verification" && record.state !== "conflicted") {
        throw new Error("Child integration can be finalized only after integration, conflict resolution, and parent verification.");
      }
      await this.workspace.finalize(record.workspace);
      await this.launcher.cleanup(record);
      return this.store.update(id, (current) => ({ ...current, state: "integrated" }));
    }
    if (record.state !== "completed") {
      throw new Error(`Only a completed child can be integrated; current state is ${record.state}.`);
    }
    if (record.childPid && isProcessAlive(record.childPid)) {
      await waitForProcessExit(record.childPid, 5_000);
    }
    const result = await this.workspace.integrate(record.workspace);
    return this.store.update(id, (current) => ({
      ...current,
      state: result.conflicted ? "conflicted" : "integrated_pending_verification",
      conflictFiles: result.conflictFiles,
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
    const disposition = await this.workspace.abandon(record.workspace);
    await this.launcher.cleanup(record);
    return this.store.update(id, (current) => ({
      ...current,
      state: "abandoned",
      workspaceRetained: !disposition.removed,
      ...(disposition.recoveryPath ? { workspaceRecoveryPath: disposition.recoveryPath } : {}),
    }));
  }

  async cleanupChildControl(id: string): Promise<void> {
    const record = await this.store.get(id);
    if (record) await this.launcher.cleanup(record);
  }

  private async reconcileExitedChild(record: DelegationRecord): Promise<DelegationRecord> {
    if (isResolvedDelegation(record) || !record.childPid || isProcessAlive(record.childPid)) return record;
    await this.launcher.cleanup(record);
    return this.store.update(record.id, (current) => isResolvedDelegation(current)
      ? current
      : {
          ...current,
          state: "failed",
          report: {
            outcome: "failed",
            summary: "Child process exited without reporting.",
            reportedAt: new Date().toISOString(),
          },
        });
  }
}

function delegationId(task: string): string {
  const slug = task.toLowerCase()
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

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) throw new Error("Child reported completion but its process did not exit.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
