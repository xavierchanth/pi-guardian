import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelPreference } from "./domain.ts";
import type { DelegationRecord, DelegationStore } from "./store.ts";

export interface ChildLaunchResult {
  pid: number;
  logPath: string;
}

export interface ChildLauncher {
  launch(record: DelegationRecord, preference: ModelPreference): Promise<ChildLaunchResult>;
}

export class PiChildProcessLauncher implements ChildLauncher {
  constructor(privateStore: DelegationStore) {
    this.store = privateStore;
  }

  private readonly store: DelegationStore;

  async launch(record: DelegationRecord, preference: ModelPreference): Promise<ChildLaunchResult> {
    if (!this.store.root) throw new Error("Detached child launch requires a file-backed delegation store.");
    const stateRoot = dirname(this.store.root);
    const sessionDir = join(stateRoot, "sessions");
    const logDir = join(stateRoot, "logs");
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const logPath = join(logDir, `${record.id}.jsonl`);
    const errorPath = join(logDir, `${record.id}.stderr.log`);
    const stdout = openSync(logPath, "a", 0o600);
    const stderr = openSync(errorPath, "a", 0o600);
    const extensionPath = fileURLToPath(new URL("../../pi-tai.ts", import.meta.url));
    const args = [
      "--mode", "json",
      "--print",
      "--no-extensions",
      "--extension", extensionPath,
      "--no-skills",
      "--session-dir", sessionDir,
      "--name", `subagent ${record.id}`,
      "--model", `${preference.provider}/${preference.model}`,
      "--thinking", preference.effort,
      "--approve",
      childPrompt(record),
    ];
    const invocation = piInvocation(args);
    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: record.childWorkspacePath,
        detached: true,
        shell: false,
        stdio: ["ignore", stdout, stderr],
        env: {
          ...process.env,
          PI_TAI_DELEGATION_ID: record.id,
          PI_TAI_DELEGATION_STORE: this.store.root,
        },
      });
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
    if (!child.pid) throw new Error("Pi child process did not start.");
    const pid = child.pid;
    child.once("error", (error) => {
      void markProcessFailure(this.store, record.id, `Child process failed: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      void markExitedWithoutReport(this.store, record.id, code, signal);
    });
    child.unref();
    return { pid, logPath };
  }
}

function childPrompt(record: DelegationRecord): string {
  return [
    `Delegation: ${record.id}`,
    `Task: ${record.task}`,
    `Workspace: ${record.childWorkspacePath}`,
    `Base change: ${record.baseChangeId}`,
    `Child root change: ${record.childRootChangeId}`,
    "Complete only this delegated task. Before finishing, call report_to_parent exactly once with the outcome and validation evidence.",
  ].join("\n");
}

function piInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

async function markProcessFailure(store: DelegationStore, id: string, reason: string): Promise<void> {
  try {
    await store.update(id, (record) => isRunning(record)
      ? {
          ...record,
          state: "failed",
          report: { outcome: "failed", summary: reason, reportedAt: new Date().toISOString() },
        }
      : record);
  } catch {
    // Parent status reconciliation can recover a missing process result.
  }
}

async function markExitedWithoutReport(
  store: DelegationStore,
  id: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): Promise<void> {
  const suffix = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
  await markProcessFailure(store, id, `Child exited without report (${suffix}).`);
}

function isRunning(record: DelegationRecord): boolean {
  return record.state === "created" || record.state === "running";
}
