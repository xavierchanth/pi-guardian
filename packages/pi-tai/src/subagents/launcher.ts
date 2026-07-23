import { execFile, spawn } from "node:child_process";
import { closeSync, constants, existsSync, mkdirSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { chmod, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { renderTaskPacket } from "./task.ts";
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
  promptPath: string;
}

export interface ChildCleanupOptions {
  runtimeArtifacts?: boolean;
}

export interface ManagedChildRuntimePaths {
  logPath: string;
  errorPath: string;
  controlPath: string;
  promptPath: string;
}

export interface ChildLauncher {
  launch(record: DelegationRecord): Promise<ChildLaunchResult>;
  message(record: DelegationRecord, message: string, delivery: ChildMessageDelivery): Promise<void>;
  cleanup(record: DelegationRecord, options?: ChildCleanupOptions): Promise<void>;
}

export function managedChildRuntimePaths(storeRoot: string, id: string): ManagedChildRuntimePaths {
  validateDelegationId(id);
  const stateRoot = dirname(storeRoot);
  return {
    logPath: join(stateRoot, "logs", `${id}.jsonl`),
    errorPath: join(stateRoot, "logs", `${id}.stderr.log`),
    controlPath: join(stateRoot, "control", `${id}.fifo`),
    promptPath: join(stateRoot, "prompts", `${id}.md`),
  };
}

export async function isManagedChildLogPath(
  storeRoot: string,
  id: string,
  candidate: string | undefined,
): Promise<boolean> {
  if (!candidate) return false;
  const expected = managedChildRuntimePaths(storeRoot, id).logPath;
  if (candidate !== expected) return false;
  const lexicalStateRoot = resolve(dirname(storeRoot));
  try {
    const [canonicalStateRoot, canonicalCandidate] = await Promise.all([
      realpath(lexicalStateRoot),
      realpath(candidate),
    ]);
    const expectedCanonicalPath = resolve(
      canonicalStateRoot,
      relative(lexicalStateRoot, resolve(expected)),
    );
    return canonicalCandidate === expectedCanonicalPath;
  } catch {
    return false;
  }
}

export class PiChildProcessLauncher implements ChildLauncher {
  constructor(privateStore: DelegationStore) {
    this.store = privateStore;
  }

  private readonly store: DelegationStore;
  private readonly controlWrites = new Map<string, Promise<void>>();

  async launch(record: DelegationRecord): Promise<ChildLaunchResult> {
    if (!this.store.root) throw new Error("Detached child launch requires a file-backed delegation store.");
    const stateRoot = dirname(this.store.root);
    const sessionDir = join(stateRoot, "sessions");
    const logDir = join(stateRoot, "logs");
    const controlDir = join(stateRoot, "control");
    const promptDir = join(stateRoot, "prompts");
    for (const directory of [sessionDir, logDir, controlDir, promptDir]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    const logPath = join(logDir, `${record.id}.jsonl`);
    const errorPath = join(logDir, `${record.id}.stderr.log`);
    const controlPath = this.controlPath(record.id);
    const promptPath = join(promptDir, `${record.id}.md`);
    writeFileSync(promptPath, `${record.agent.systemPrompt.trim()}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await execFileAsync("mkfifo", [controlPath]);
    await chmod(controlPath, 0o600);
    const stdout = openSync(logPath, "a", 0o600);
    const stderr = openSync(errorPath, "a", 0o600);
    const control = openSync(controlPath, constants.O_RDWR);
    const extensionPath = fileURLToPath(new URL("../../subagent.ts", import.meta.url));
    const args = [
      "--mode", "rpc",
      "--no-extensions",
      "--extension", extensionPath,
      "--no-skills",
      "--session-dir", sessionDir,
      "--name", `${record.agent.name} ${record.id}`,
      "--model", `${record.agent.provider}/${record.agent.model}`,
      "--thinking", record.agent.effort,
      "--tools", record.agent.tools.join(","),
      "--append-system-prompt", promptPath,
      "--approve",
    ];
    const invocation = piInvocation(args);
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: record.cwd,
        detached: true,
        shell: false,
        stdio: [control, stdout, stderr],
        env: {
          ...process.env,
          PI_TAI_DELEGATION_ID: record.id,
          PI_TAI_DELEGATION_STORE: this.store.root,
          PI_TAI_AGENT_NAME: record.agent.name,
          PI_TAI_ALLOWED_CHILDREN: JSON.stringify(record.agent.allowedChildren),
        },
      });
      writeSync(control, rpcPrompt(childPrompt(record)));
    } catch (error) {
      child?.kill("SIGTERM");
      rmSync(controlPath, { force: true });
      rmSync(promptPath, { force: true });
      throw error;
    } finally {
      closeSync(control);
      closeSync(stdout);
      closeSync(stderr);
    }
    if (!child?.pid) {
      rmSync(controlPath, { force: true });
      rmSync(promptPath, { force: true });
      throw new Error("Pi child process did not start.");
    }
    const pid = child.pid;
    child.once("error", (error) => {
      rmSync(controlPath, { force: true });
      rmSync(promptPath, { force: true });
      void markProcessFailure(this.store, record.id, `Child process failed: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      rmSync(controlPath, { force: true });
      rmSync(promptPath, { force: true });
      void markExitedWithoutReport(this.store, record.id, code, signal);
    });
    child.unref();
    return { pid, logPath, controlPath, promptPath };
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
      const hardSubmit = delivery === "steer"
        && Boolean(record.childLogPath)
        && await isWaitingForChildren(record.childLogPath!);
      const payload = hardSubmit
        ? `${JSON.stringify({ type: "abort" })}\n${rpcPrompt(message)}`
        : rpcPrompt(message, delivery);
      const control = await open(controlPath, constants.O_WRONLY | constants.O_NONBLOCK);
      try {
        await control.writeFile(payload);
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

  async cleanup(record: DelegationRecord, options: ChildCleanupOptions = {}): Promise<void> {
    const paths = managedChildRuntimePaths(this.requireStoreRoot(), record.id);
    const candidates = options.runtimeArtifacts
      ? Object.values(paths)
      : [paths.controlPath, paths.promptPath];
    for (const path of candidates) await this.removeManagedArtifact(path);
    this.controlWrites.delete(paths.controlPath);
  }

  private controlPath(id: string): string {
    this.validateId(id);
    return join(this.stateRoot(), "control", `${id}.fifo`);
  }

  private promptPath(id: string): string {
    this.validateId(id);
    return join(this.stateRoot(), "prompts", `${id}.md`);
  }

  private stateRoot(): string {
    return dirname(this.requireStoreRoot());
  }

  private requireStoreRoot(): string {
    if (!this.store.root) throw new Error("Detached child control requires a file-backed delegation store.");
    return this.store.root;
  }

  private validateId(id: string): void {
    validateDelegationId(id);
  }

  private async removeManagedArtifact(path: string): Promise<void> {
    const lexicalStateRoot = resolve(this.stateRoot());
    const lexicalParent = resolve(dirname(path));
    try {
      const [canonicalStateRoot, canonicalParent] = await Promise.all([
        realpath(lexicalStateRoot),
        realpath(lexicalParent),
      ]);
      const expectedParent = resolve(canonicalStateRoot, relative(lexicalStateRoot, lexicalParent));
      if (canonicalParent !== expectedParent) return;
      await rm(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function validateDelegationId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid delegation id: ${id}`);
}

function childPrompt(record: DelegationRecord): string {
  return [
    `Delegation: ${record.id}`,
    `Agent: ${record.agent.name}`,
    `Working directory: ${record.cwd}`,
    "The parent conversation is intentionally unavailable. Treat the following packet as the complete assignment.",
    "",
    renderTaskPacket(record.task),
    "",
    "Before finishing, resolve every child you create and call report_to_parent exactly once with outcome and validation evidence.",
  ].join("\n");
}

async function isWaitingForChildren(logPath: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(logPath, "r");
    const info = await handle.stat();
    const length = Math.min(info.size, 256 * 1024);
    if (length === 0) return false;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (info.size > length) lines.shift();
    for (let index = lines.length - 1; index >= 0; index--) {
      let frame: { type?: unknown; toolName?: unknown };
      try { frame = JSON.parse(lines[index] ?? ""); } catch { continue; }
      if (frame.type === "tool_execution_update" || frame.type === "tool_execution_start") {
        return frame.toolName === "wait_for_children";
      }
      if (
        frame.type === "tool_execution_end"
        || frame.type === "agent_end"
        || frame.type === "agent_settled"
        || frame.type === "message_start"
      ) return false;
    }
    return false;
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
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
  if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
  return { command: "pi", args };
}

async function markProcessFailure(store: DelegationStore, id: string, reason: string): Promise<void> {
  try {
    await store.update(id, (record) => isActive(record)
      ? {
          ...record,
          execution: {
            phase: "failed",
            report: { outcome: "failed", summary: reason, reportedAt: new Date().toISOString() },
          },
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

function isActive(record: DelegationRecord): boolean {
  return ["created", "running", "awaiting_parent"].includes(record.execution.phase);
}
