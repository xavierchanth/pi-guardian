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
  parentChangeId: string;
  baseChangeId: string;
  childWorkspace: string;
  childWorkspacePath: string;
  childRootChangeId: string;
}

export interface IntegrateChildWorkspaceInput {
  repoRoot: string;
  parentWorkspace: string;
  parentChangeId: string;
  childWorkspace: string;
  childWorkspacePath: string;
  baseChangeId: string;
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
      `exactly(change_id(${baseChangeId}), 1)`,
    ]);

    try {
      await this.verifySourceSibling(parentCwd, parentWorkspace, parentChangeId, baseChangeId);
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
        parentChangeId,
        baseChangeId,
        childWorkspace,
        childWorkspacePath,
        childRootChangeId,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Planner workspace creation stopped after allocation at ${childWorkspacePath}: ${reason} Preserve the workspace and ask the user to intervene.`,
      );
    }
  }

  async createRelocationWorkspace(
    sourceCwd: string,
    workspaceName: string,
  ): Promise<CreatedChildWorkspace> {
    validateWorkspaceName(workspaceName);
    const repoRoot = line(await this.run(sourceCwd, ["root"]), "Jujutsu repository root");
    const sourceChangeId = line(
      await this.run(sourceCwd, ["log", "-r", "@", "--no-graph", "-T", CHANGE_ID_TEMPLATE]),
      "source working-copy change ID",
    );
    const sourceWorkspace = currentWorkspace(
      await this.run(sourceCwd, ["workspace", "list", "-T", WORKSPACE_TEMPLATE]),
      sourceChangeId,
    );
    const baseChangeId = line(
      await this.run(sourceCwd, ["log", "-r", "@-", "--no-graph", "-T", CHANGE_ID_TEMPLATE]),
      "source @- change ID",
    );
    const workspacesRoot = join(repoRoot, ".jj", "workspaces");
    const workspacePath = join(workspacesRoot, workspaceName);
    await this.files.mkdir(workspacesRoot);
    await this.run(sourceCwd, [
      "workspace",
      "add",
      workspacePath,
      "--name",
      workspaceName,
      "-r",
      `exactly(change_id(${baseChangeId}), 1)`,
    ]);
    try {
      await this.verifySourceSibling(sourceCwd, sourceWorkspace, sourceChangeId, baseChangeId);
      const rootChangeId = line(
        await this.run(workspacePath, ["log", "-r", "@", "--no-graph", "-T", CHANGE_ID_TEMPLATE]),
        "successor workspace root change ID",
      );
      const actualBase = line(
        await this.run(workspacePath, ["log", "-r", "@-", "--no-graph", "-T", CHANGE_ID_TEMPLATE]),
        "successor workspace parent change ID",
      );
      if (actualBase !== baseChangeId) {
        throw new Error(`Successor workspace parent mismatch: expected ${baseChangeId}, received ${actualBase}.`);
      }
      return {
        repoRoot,
        parentWorkspace: sourceWorkspace,
        parentChangeId: sourceChangeId,
        baseChangeId,
        childWorkspace: workspaceName,
        childWorkspacePath: workspacePath,
        childRootChangeId: rootChangeId,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Workspace creation stopped after allocation at ${workspacePath}: ${reason} Preserve the workspace and ask the user to intervene.`,
      );
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
    const parentRevision = `${input.parentWorkspace}@`;
    const childRevision = `${input.childWorkspace}@`;
    const childTargetBefore = await this.workspaceTargetChangeId(input.repoRoot, childRevision);
    const parentTargetBefore = await this.workspaceTargetChangeId(input.repoRoot, parentRevision);
    if (parentTargetBefore !== input.parentChangeId) {
      throw new Error(`Source workspace target changed before integration: expected ${input.parentChangeId}, received ${parentTargetBefore}.`);
    }
    const childUpdate = await this.run(input.childWorkspacePath, ["workspace", "update-stale"]);
    const parentUpdate = await this.run(input.repoRoot, ["workspace", "update-stale"]);
    const childTargetAfter = await this.workspaceTargetChangeId(input.repoRoot, childRevision);
    const parentTargetAfter = await this.workspaceTargetChangeId(input.repoRoot, parentRevision);
    if (
      /recovery/i.test(`${childUpdate}\n${parentUpdate}`)
      || childTargetBefore !== childTargetAfter
      || parentTargetBefore !== parentTargetAfter
    ) {
      throw new Error("Updating a stale workspace created or exposed unexpected recovery history.");
    }

    const rootRevision = `exactly(change_id(${input.childRootChangeId}), 1)`;
    const baseRevision = `exactly(change_id(${input.baseChangeId}), 1)`;
    const parentChangeRevision = `exactly(change_id(${input.parentChangeId}), 1)`;
    const sourceDiffBefore = await this.run(input.repoRoot, ["diff", "-r", parentRevision, "--git"]);
    const sourceParent = line(
      await this.run(input.repoRoot, [
        "--ignore-working-copy", "log", "-r", `parents(${parentChangeRevision})`,
        "--no-graph", "-T", CHANGE_ID_TEMPLATE,
      ]),
      "source working-copy parent change ID",
    );
    if (sourceParent !== input.baseChangeId) {
      throw new Error(`Source workspace parent changed before integration: expected ${input.baseChangeId}, received ${sourceParent}.`);
    }

    const linkedRoot = line(
      await this.run(input.childWorkspacePath, [
        "log",
        "-r",
        `${rootRevision} & ::${childRevision}`,
        "--no-graph",
        "-T",
        CHANGE_ID_TEMPLATE,
      ]),
      "recorded child subtree root",
    );
    if (linkedRoot !== input.childRootChangeId) {
      throw new Error(`Child workspace no longer descends from recorded root ${input.childRootChangeId}.`);
    }
    const linkedBase = line(
      await this.run(input.childWorkspacePath, [
        "log",
        "-r",
        `parents(${rootRevision}) & ${baseRevision}`,
        "--no-graph",
        "-T",
        CHANGE_ID_TEMPLATE,
      ]),
      "recorded child subtree base",
    );
    if (linkedBase !== input.baseChangeId) {
      throw new Error(`Child workspace root no longer descends directly from base ${input.baseChangeId}.`);
    }
    const foreignDescendants = await this.run(input.childWorkspacePath, [
      "log",
      "-r",
      `${rootRevision}:: ~ ::${childRevision}`,
      "--no-graph",
      "-T",
      CHANGE_ID_TEMPLATE,
    ]);
    if (foreignDescendants.trim()) {
      throw new Error("Child workspace subtree has descendants outside its working-copy ancestry.");
    }

    await this.run(input.repoRoot, [
      "rebase",
      "-s",
      rootRevision,
      "-B",
      parentRevision,
    ]);
    const integratedRoot = line(
      await this.run(input.repoRoot, [
        "log",
        "-r",
        `${rootRevision} & ::${parentRevision}`,
        "--no-graph",
        "-T",
        CHANGE_ID_TEMPLATE,
      ]),
      "integrated child subtree root",
    );
    if (integratedRoot !== input.childRootChangeId) {
      throw new Error("Rebase completed but the child subtree is not an ancestor of the source workspace.");
    }
    const parentTargetIntegrated = await this.workspaceTargetChangeId(input.repoRoot, parentRevision);
    if (parentTargetIntegrated !== input.parentChangeId) {
      throw new Error(`Rebase changed source workspace identity: expected ${input.parentChangeId}, received ${parentTargetIntegrated}.`);
    }
    const integratedTip = line(
      await this.run(input.repoRoot, [
        "--ignore-working-copy", "log", "-r", `parents(${parentChangeRevision})`,
        "--no-graph", "-T", CHANGE_ID_TEMPLATE,
      ]),
      "integrated source parent change ID",
    );
    if (integratedTip !== childTargetAfter) {
      throw new Error("Rebase completed with an unexpected graph: the complete delegated tip is not directly before the source workspace.");
    }
    const unexpectedIntegrated = await this.run(input.repoRoot, [
      "--ignore-working-copy", "log", "-r", `${rootRevision}:: ~ ::${parentChangeRevision}`,
      "--no-graph", "-T", CHANGE_ID_TEMPLATE,
    ]);
    if (unexpectedIntegrated.trim()) {
      throw new Error("Rebase completed with descendants outside the integrated source ancestry.");
    }
    const conflictFiles = await this.listConflicts(input.repoRoot, parentRevision);
    if (conflictFiles.length === 0) {
      const sourceDiffAfter = await this.run(input.repoRoot, ["diff", "-r", parentRevision, "--git"]);
      if (sourceDiffAfter !== sourceDiffBefore) {
        throw new Error("Rebase changed the source working-copy diff instead of preserving its concurrent work.");
      }
    }
    return { conflicted: conflictFiles.length > 0, conflictFiles };
  }

  async finalizeChildWorkspace(input: {
    repoRoot: string;
    parentWorkspace: string;
    childWorkspace: string;
    childWorkspacePath: string;
  }): Promise<void> {
    const parentRevision = `${input.parentWorkspace}@`;
    const childRevision = `${input.childWorkspace}@`;
    const conflictFiles = await this.listConflicts(input.repoRoot, parentRevision);
    if (conflictFiles.length > 0) throw new Error("Cannot finalize child workspace while parent conflicts remain.");
    const childTarget = await this.workspaceTargetChangeId(input.repoRoot, childRevision);
    const integratedTarget = line(
      await this.run(input.repoRoot, [
        "--ignore-working-copy", "log", "-r",
        `exactly(change_id(${childTarget}), 1) & ::${parentRevision}`,
        "--no-graph", "-T", CHANGE_ID_TEMPLATE,
      ]),
      "integrated child workspace target",
    );
    if (integratedTarget !== childTarget) {
      throw new Error("Cannot finalize a child workspace whose current target is not integrated into the source workspace.");
    }
    await this.run(input.repoRoot, ["workspace", "forget", input.childWorkspace]);
    await this.files.rm(input.childWorkspacePath);
  }

  async abandonChildWorkspace(input: {
    repoRoot: string;
    childWorkspace: string;
    childWorkspacePath: string;
  }): Promise<boolean> {
    await this.run(input.childWorkspacePath, ["status"]);
    const childDiff = await this.run(input.repoRoot, ["diff", "-r", `${input.childWorkspace}@`, "--summary"]);
    if (childDiff.trim()) return false;
    await this.run(input.repoRoot, ["workspace", "forget", input.childWorkspace]);
    await this.files.rm(input.childWorkspacePath);
    return true;
  }

  private async verifySourceSibling(
    cwd: string,
    workspace: string,
    sourceChangeId: string,
    baseChangeId: string,
  ): Promise<void> {
    const sourceTarget = await this.workspaceTargetChangeId(cwd, `${workspace}@`);
    if (sourceTarget !== sourceChangeId) {
      throw new Error(`Source workspace target changed during allocation: expected ${sourceChangeId}, received ${sourceTarget}.`);
    }
    const sourceParent = line(
      await this.run(cwd, [
        "--ignore-working-copy",
        "log",
        "-r",
        `parents(exactly(change_id(${sourceChangeId}), 1))`,
        "--no-graph",
        "-T",
        CHANGE_ID_TEMPLATE,
      ]),
      "source working-copy parent change ID",
    );
    if (sourceParent !== baseChangeId) {
      throw new Error(`Source workspace parent changed during allocation: expected ${baseChangeId}, received ${sourceParent}.`);
    }
  }

  private async workspaceTargetChangeId(cwd: string, revision: string): Promise<string> {
    return line(
      await this.run(cwd, [
        "--ignore-working-copy",
        "log",
        "-r",
        revision,
        "--no-graph",
        "-T",
        CHANGE_ID_TEMPLATE,
      ]),
      `${revision} workspace target change ID`,
    );
  }

  private async listConflicts(cwd: string, revision: string): Promise<string[]> {
    try {
      const output = await this.run(cwd, ["resolve", "--list", "-r", revision]);
      return output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("No conflicts found at this revision")) return [];
      throw error;
    }
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
