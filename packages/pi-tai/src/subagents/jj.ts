import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CHANGE_ID_TEMPLATE = 'change_id ++ "\\n"';
const WORKSPACE_TEMPLATE = 'name ++ "|" ++ target.change_id() ++ "\\n"';

export type JjCommandRunner = (cwd: string, args: string[]) => Promise<string>;

export interface JjFileOperations {
  mkdir(path: string): Promise<void>;
  rm(path: string): Promise<void>;
}

export interface CreatedChildWorkspace {
  repoRoot: string;
  parentWorkspace: string;
  baseChangeId: string;
  childWorkspace: string;
  childWorkspacePath: string;
  childRootChangeId: string;
}

export interface IntegrateChildWorkspaceInput {
  repoRoot: string;
  parentWorkspace: string;
  childWorkspace: string;
  childWorkspacePath: string;
  childRootChangeId: string;
}

export interface IntegrateChildWorkspaceResult {
  conflicted: boolean;
  conflictFiles: string[];
}

export class JjWorkspaceService {
  private readonly run: JjCommandRunner;
  private readonly files: JjFileOperations;

  constructor(
    run: JjCommandRunner = runJjCommand,
    files: JjFileOperations = {
      mkdir: async (path) => { await mkdir(path, { recursive: true, mode: 0o700 }); },
      rm: async (path) => { await rm(path, { recursive: true, force: true }); },
    },
  ) {
    this.run = run;
    this.files = files;
  }

  async createChildWorkspace(
    parentCwd: string,
    childWorkspace: string,
  ): Promise<CreatedChildWorkspace> {
    validateWorkspaceName(childWorkspace);
    const repoRoot = line(await this.run(parentCwd, ["root"]), "Jujutsu repository root");
    const parentChangeId = line(
      await this.run(parentCwd, ["log", "-r", "@", "--no-graph", "-T", CHANGE_ID_TEMPLATE]),
      "parent working-copy change ID",
    );
    const parentWorkspace = currentWorkspace(
      await this.run(parentCwd, ["workspace", "list", "-T", WORKSPACE_TEMPLATE]),
      parentChangeId,
    );
    const parentDiff = await this.run(parentCwd, ["diff", "--stat"]);
    if (parentDiff.trim()) {
      throw new Error("Subagents require a fresh empty parent @. Checkpoint the current work and create a new change first.");
    }
    const baseChangeId = line(
      await this.run(parentCwd, ["log", "-r", "@-", "--no-graph", "-T", CHANGE_ID_TEMPLATE]),
      "parent @- change ID",
    );

    const workspacesRoot = join(repoRoot, ".jj", "workspaces");
    const childWorkspacePath = join(workspacesRoot, childWorkspace);
    await this.files.mkdir(workspacesRoot);
    await this.run(parentCwd, [
      "workspace",
      "add",
      childWorkspacePath,
      "--name",
      childWorkspace,
      "-r",
      baseChangeId,
    ]);

    try {
      const childRootChangeId = line(
        await this.run(childWorkspacePath, ["log", "-r", "@", "--no-graph", "-T", CHANGE_ID_TEMPLATE]),
        "child root change ID",
      );
      const actualBase = line(
        await this.run(childWorkspacePath, ["log", "-r", "@-", "--no-graph", "-T", CHANGE_ID_TEMPLATE]),
        "child root parent change ID",
      );
      if (actualBase !== baseChangeId) {
        throw new Error(`Child workspace parent mismatch: expected ${baseChangeId}, received ${actualBase}.`);
      }
      return {
        repoRoot,
        parentWorkspace,
        baseChangeId,
        childWorkspace,
        childWorkspacePath,
        childRootChangeId,
      };
    } catch (error) {
      await this.run(parentCwd, ["workspace", "forget", childWorkspace]).catch(() => undefined);
      await this.files.rm(childWorkspacePath).catch(() => undefined);
      throw error;
    }
  }

  async currentChangeId(cwd: string): Promise<string> {
    return line(
      await this.run(cwd, ["log", "-r", "@", "--no-graph", "-T", CHANGE_ID_TEMPLATE]),
      "working-copy change ID",
    );
  }

  async integrateChildWorkspace(
    input: IntegrateChildWorkspaceInput,
  ): Promise<IntegrateChildWorkspaceResult> {
    await this.run(input.childWorkspacePath, ["workspace", "update-stale"]);
    const linkedRoot = line(
      await this.run(input.childWorkspacePath, [
        "log",
        "-r",
        `ancestors(@) & ${input.childRootChangeId}`,
        "--no-graph",
        "-T",
        CHANGE_ID_TEMPLATE,
      ]),
      "recorded child subtree root",
    );
    if (linkedRoot !== input.childRootChangeId) {
      throw new Error(`Child workspace no longer descends from recorded root ${input.childRootChangeId}.`);
    }
    await this.run(input.repoRoot, [
      "rebase",
      "-s",
      input.childRootChangeId,
      "-B",
      `${input.parentWorkspace}@`,
    ]);
    const conflicts = await this.run(input.repoRoot, ["resolve", "--list"]);
    const conflictFiles = conflicts.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    return { conflicted: conflictFiles.length > 0, conflictFiles };
  }

  async finalizeChildWorkspace(input: {
    repoRoot: string;
    parentWorkspace: string;
    childWorkspace: string;
    childWorkspacePath: string;
  }): Promise<void> {
    const conflicts = await this.run(input.repoRoot, ["resolve", "--list"]);
    if (conflicts.trim()) throw new Error("Cannot finalize child workspace while parent conflicts remain.");
    await this.run(input.repoRoot, ["workspace", "forget", input.childWorkspace]);
    await this.files.rm(input.childWorkspacePath);
  }

  async abandonChildWorkspace(input: {
    repoRoot: string;
    childWorkspace: string;
    childWorkspacePath: string;
  }): Promise<void> {
    await this.run(input.repoRoot, ["workspace", "forget", input.childWorkspace]);
    await this.files.rm(input.childWorkspacePath);
  }
}

export async function runJjCommand(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("jj", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, JJ_NO_PAGER: "1" },
    });
    return result.stdout;
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    const detail = failure.stderr?.trim() || failure.message;
    throw new Error(`jj ${args.join(" ")} failed: ${detail}`);
  }
}

function currentWorkspace(output: string, currentChangeId: string): string {
  const matches = output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("|", 2))
    .filter(([, changeId]) => changeId === currentChangeId)
    .map(([name]) => name);
  if (matches.length !== 1) {
    throw new Error(`Unable to identify current Jujutsu workspace for change ${currentChangeId}.`);
  }
  return matches[0];
}

function line(output: string, label: string): string {
  const value = output.trim();
  if (!value || value.includes("\n")) throw new Error(`Unable to resolve ${label}.`);
  return value;
}

function validateWorkspaceName(value: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(value)) {
    throw new Error(`Invalid child workspace name: ${value}`);
  }
}
