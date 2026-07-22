import { execFile, spawn } from "node:child_process";
import { closeSync, constants, existsSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { chmod, open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { ModelPreference } from "./domain.ts";
import type {
  ChildMessageDelivery,
  DelegationRecord,
  DelegationStore,
} from "./store.ts";

const execFileAsync = promisify(execFile);

export interface ChildLaunchResult {
  pid: number;
  logPath: string;
  controlPath: string;
}

export interface ChildLauncher {
  launch(record: DelegationRecord, preference: ModelPreference): Promise<ChildLaunchResult>;
  message(record: DelegationRecord, message: string, delivery: ChildMessageDelivery): Promise<void>;
  cleanup(record: DelegationRecord): Promise<void>;
}

export class PiChildProcessLauncher implements ChildLauncher {
  constructor(privateStore: DelegationStore) {
    this.store = privateStore;
  }

  private readonly store: DelegationStore;
  private readonly controlWrites = new Map<string, Promise<void>>();

  async launch(record: DelegationRecord, preference: ModelPreference): Promise<ChildLaunchResult> {
    if (!this.store.root) throw new Error("Detached child launch requires a file-backed delegation store.");
    const stateRoot = dirname(this.store.root);
    const sessionDir = join(stateRoot, "sessions");
    const logDir = join(stateRoot, "logs");
    const controlDir = join(stateRoot, "control");
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    mkdirSync(controlDir, { recursive: true, mode: 0o700 });
    const logPath = join(logDir, `${record.id}.jsonl`);
    const errorPath = join(logDir, `${record.id}.stderr.log`);
    const controlPath = this.controlPath(record.id);
    await execFileAsync("mkfifo", [controlPath]);
    await chmod(controlPath, 0o600);
    const stdout = openSync(logPath, "a", 0o600);
    const stderr = openSync(errorPath, "a", 0o600);
    const control = openSync(controlPath, constants.O_RDWR);
    const extensionPath = fileURLToPath(new URL("../../pi-tai.ts", import.meta.url));
    const args = [
      "--mode", "rpc",
      "--no-extensions",
      "--extension", extensionPath,
      "--no-skills",
      "--session-dir", sessionDir,
      "--name", `subagent ${record.id}`,
      "--model", `${preference.provider}/${preference.model}`,
      "--thinking", preference.effort,
      "--approve",
    ];
    const invocation = piInvocation(args);
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: record.workspace.path,
        detached: true,
        shell: false,
        stdio: [control, stdout, stderr],
        env: {
          ...process.env,
          PI_TAI_DELEGATION_ID: record.id,
          PI_TAI_DELEGATION_STORE: this.store.root,
        },
      });
      writeSync(control, rpcPrompt(childPrompt(record)));
    } catch (error) {
      child?.kill("SIGTERM");
      rmSync(controlPath, { force: true });
      throw error;
    } finally {
      closeSync(control);
      closeSync(stdout);
      closeSync(stderr);
    }
    if (!child?.pid) {
      rmSync(controlPath, { force: true });
      throw new Error("Pi child process did not start.");
    }
    const pid = child.pid;
    child.once("error", (error) => {
      rmSync(controlPath, { force: true });
      void markProcessFailure(this.store, record.id, `Child process failed: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      rmSync(controlPath, { force: true });
      void markExitedWithoutReport(this.store, record.id, code, signal);
    });
    child.unref();
    return { pid, logPath, controlPath };
  }

  async message(
    record: DelegationRecord,
    message: string,
    delivery: ChildMessageDelivery,
  ): Promise<void> {
    const controlPath = record.childControlPath;
    if (!controlPath) throw new Error("Child control channel is unavailable.");
    if (controlPath !== this.controlPath(record.id)) {
      throw new Error("Child control channel does not match its managed path.");
    }
    const previous = this.controlWrites.get(controlPath) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const control = await open(controlPath, constants.O_WRONLY | constants.O_NONBLOCK);
      try {
        await control.writeFile(rpcPrompt(message, delivery));
      } finally {
        await control.close();
      }
    });
    this.controlWrites.set(controlPath, next);
    try {
      await next;
    } finally {
      if (this.controlWrites.get(controlPath) === next) this.controlWrites.delete(controlPath);
    }
  }

  async cleanup(record: DelegationRecord): Promise<void> {
    if (record.childControlPath === this.controlPath(record.id)) {
      rmSync(record.childControlPath, { force: true });
    }
  }

  private controlPath(id: string): string {
    if (!this.store.root) throw new Error("Detached child control requires a file-backed delegation store.");
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid delegation id: ${id}`);
    return join(dirname(this.store.root), "control", `${id}.fifo`);
  }
}

function childPrompt(record: DelegationRecord): string {
  return [
    `Delegation: ${record.id}`,
    `Task: ${record.task}`,
    `Workspace backend: ${record.workspace.backend}`,
    `Workspace: ${record.workspace.path}`,
    ...(record.workspace.backend === "jj"
      ? [
          `Base change: ${record.workspace.baseChangeId}`,
          `Child root change: ${record.workspace.rootChangeId}`,
        ]
      : [
          `Base commit: ${record.workspace.baseCommit}`,
          `Child branch: ${record.workspace.branch}`,
        ]),
    ...(record.workspace.backend === "git"
      ? ["Commit intended Git worktree changes on the delegated branch and leave the worktree clean before reporting."]
      : []),
    "Complete only this delegated task. Accept parent messages as updated instructions. Before finishing, call report_to_parent exactly once with the outcome and validation evidence.",
  ].join("\n");
}

function rpcPrompt(message: string, streamingBehavior?: ChildMessageDelivery): string {
  return `${JSON.stringify({
    type: "prompt",
    message,
    ...(streamingBehavior ? { streamingBehavior } : {}),
  })}\n`;
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
