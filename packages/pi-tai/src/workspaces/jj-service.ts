import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { absolutePath } from "../jj/domain.ts";
import {
  JjProcessExecutor,
  renderJjExecutionFailure,
  type JjAccess,
  type JjExecutor,
} from "../jj/executor.ts";
const CHANGE_ID_TEMPLATE = 'change_id ++ "\\n"';
const WORKSPACE_TEMPLATE = 'name ++ "|" ++ target.change_id() ++ "\\n"';
const CHANGE_ROW_TEMPLATE = 'change_id ++ "|" ++ if(empty, "empty", "nonempty") ++ "|" ++ description.first_line() ++ "\\n"';

export interface JjFileOperations {
  mkdir(path: string): Promise<void>;
  rm(path: string): Promise<void>;
}

export interface CreatedChildWorkspace {
  repoRoot: string;
  parentWorkspace: string;
  parentWorkspacePath: string;
  baseChangeId: string;
  childWorkspace: string;
  childWorkspacePath: string;
  childRootChangeId: string;
}

export interface IntegrateChildWorkspaceInput {
  repoRoot: string;
  parentWorkspace: string;
  parentWorkspacePath: string;
  childWorkspace: string;
  childWorkspacePath: string;
  baseChangeId: string;
  childRootChangeId: string;
}

export class JjWorkspaceIntegrationError extends Error {
  readonly workspaceRemoved: boolean;

  constructor(message: string, workspaceRemoved: boolean) {
    super(message);
    this.name = "JjWorkspaceIntegrationError";
    this.workspaceRemoved = workspaceRemoved;
  }
}

export interface IntegrateChildWorkspaceResult {
  conflicted: boolean;
  conflictFiles: string[];
  integratedChangeIds: string[];
  undescribedChangeIds: string[];
  removedEmptyChangeIds: string[];
  sourceChangeId: string;
  workspaceRemoved: boolean;
}

export class JjWorkspaceService {
  private readonly executor: JjExecutor;
  private readonly files: JjFileOperations;

  constructor(
    executor: JjExecutor = new JjProcessExecutor(),
    files: JjFileOperations = {
      mkdir: async (path) => { await mkdir(path, { recursive: true, mode: 0o700 }); },
      rm: async (path) => { await rm(path, { recursive: true, force: true }); },
    },
  ) {
    this.executor = executor;
    this.files = files;
  }

  async repositoryRoot(cwd: string): Promise<string> {
    return line(await this.run(cwd, ["root"]), "Jujutsu repository root");
  }

  async createChildWorkspace(parentCwd: string, childWorkspace: string): Promise<CreatedChildWorkspace> {
    return this.createWorkspace(parentCwd, childWorkspace, false);
  }

  async createRelocationWorkspace(sourceCwd: string, workspaceName: string): Promise<CreatedChildWorkspace> {
    return this.createWorkspace(sourceCwd, workspaceName, true);
  }

  private async createWorkspace(sourceCwd: string, workspaceName: string, cleanupOnFailure: boolean): Promise<CreatedChildWorkspace> {
    validateWorkspaceName(workspaceName);
    const repoRoot = line(await this.run(sourceCwd, ["root"]), "Jujutsu repository root");
    const sourceChangeId = line(await this.run(sourceCwd, ["log", "--revision", "@", "--no-graph", "--template", CHANGE_ID_TEMPLATE]), "source working-copy change ID");
    const sourceWorkspace = currentWorkspace(await this.run(sourceCwd, ["workspace", "list", "--template", WORKSPACE_TEMPLATE]), sourceChangeId);
    const baseChangeId = line(await this.run(sourceCwd, ["log", "--revision", "@-", "--no-graph", "--template", CHANGE_ID_TEMPLATE]), "source @- change ID");
    const workspacesRoot = join(repoRoot, ".jj", "workspaces");
    const workspacePath = join(workspacesRoot, workspaceName);
    await this.files.mkdir(workspacesRoot);
    await this.run(sourceCwd, ["workspace", "add", workspacePath, "--name", workspaceName, "--revision", exactChange(baseChangeId)], "write");
    try {
      await this.verifySourceSibling(sourceCwd, sourceWorkspace, sourceChangeId, baseChangeId);
      const rootChangeId = line(await this.run(workspacePath, ["log", "--revision", "@", "--no-graph", "--template", CHANGE_ID_TEMPLATE]), "workspace root change ID");
      const actualBase = line(await this.run(workspacePath, ["log", "--revision", "@-", "--no-graph", "--template", CHANGE_ID_TEMPLATE]), "workspace root parent change ID");
      if (actualBase !== baseChangeId) throw new Error(`Workspace parent mismatch: expected ${baseChangeId}, received ${actualBase}.`);
      return {
        repoRoot,
        parentWorkspace: sourceWorkspace,
        parentWorkspacePath: sourceCwd,
        baseChangeId,
        childWorkspace: workspaceName,
        childWorkspacePath: workspacePath,
        childRootChangeId: rootChangeId,
      };
    } catch (error) {
      if (cleanupOnFailure) {
        await this.run(sourceCwd, ["workspace", "forget", workspaceName], "write").catch(() => undefined);
        await this.files.rm(workspacePath).catch(() => undefined);
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Workspace creation stopped after allocation at ${workspacePath}: ${reason}`);
    }
  }

  async currentChangeId(cwd: string): Promise<string> {
    return line(await this.run(cwd, ["log", "--revision", "@", "--no-graph", "--template", CHANGE_ID_TEMPLATE]), "working-copy change ID");
  }

  async integrateChildWorkspace(input: IntegrateChildWorkspaceInput): Promise<IntegrateChildWorkspaceResult> {
    const childUpdate = await this.run(input.childWorkspacePath, ["workspace", "update-stale"], "write");
    const parentUpdate = await this.run(input.parentWorkspacePath, ["workspace", "update-stale"], "write");
    if (/recovery/i.test(`${childUpdate}\n${parentUpdate}`)) {
      throw new Error("Updating stale workspaces created recovery history.");
    }

    const parentRevision = `${input.parentWorkspace}@`;
    const childRevision = `${input.childWorkspace}@`;
    const sourceChangeId = await this.workspaceTargetChangeId(input.repoRoot, parentRevision);
    const childTipChangeId = await this.workspaceTargetChangeId(input.repoRoot, childRevision);
    const rootRevision = exactChange(input.childRootChangeId);
    const baseRevision = exactChange(input.baseChangeId);
    const childTipRevision = exactChange(childTipChangeId);

    const linkedRoot = line(await this.run(input.childWorkspacePath, ["log", "--revision", `${rootRevision} & ::${childTipRevision}`, "--no-graph", "--template", CHANGE_ID_TEMPLATE]), "recorded child root");
    if (linkedRoot !== input.childRootChangeId) throw new Error(`Workspace no longer descends from recorded root ${input.childRootChangeId}.`);
    const linkedBase = line(await this.run(input.childWorkspacePath, ["log", "--revision", `parents(${rootRevision}) & ${baseRevision}`, "--no-graph", "--template", CHANGE_ID_TEMPLATE]), "recorded child base");
    if (linkedBase !== input.baseChangeId) throw new Error(`Workspace root no longer descends directly from base ${input.baseChangeId}.`);
    const foreign = await this.run(input.childWorkspacePath, ["log", "--revision", `${rootRevision}:: ~ ::${childTipRevision}`, "--no-graph", "--template", CHANGE_ID_TEMPLATE]);
    if (foreign.trim()) throw new Error("Delegated subtree has descendants outside its workspace ancestry.");

    const range = `${rootRevision}::${childTipRevision}`;
    const rows = parseChangeRows(await this.run(input.childWorkspacePath, ["log", "--revision", range, "--no-graph", "--template", CHANGE_ROW_TEMPLATE]));
    if (rows.length === 0) throw new Error("Delegated workspace range is empty or unresolved.");
    const emptyIds = rows.filter((row) => row.empty).map((row) => row.id);
    const nonemptyIds = rows.filter((row) => !row.empty).map((row) => row.id);

    await this.run(input.repoRoot, ["workspace", "forget", input.childWorkspace], "write");
    await this.files.rm(input.childWorkspacePath);

    try {
      for (const emptyId of emptyIds) {
        try {
          await this.run(input.repoRoot, ["--ignore-working-copy", "abandon", exactChange(emptyId)], "write");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/fewer than the expected 1 revisions \(got 0\)/.test(message)) throw error;
        }
      }
      if (nonemptyIds.length > 0) {
        await this.run(input.repoRoot, ["--ignore-working-copy", "rebase", "--revision", changeUnion(nonemptyIds), "--insert-before", exactChange(sourceChangeId)], "write");
      }

      const integratedIds = nonemptyIds.length === 0 ? [] : lines(await this.run(input.repoRoot, [
        "--ignore-working-copy", "log", "--revision", `${changeUnion(nonemptyIds)} & ::${exactChange(sourceChangeId)}`, "--no-graph", "--template", CHANGE_ID_TEMPLATE,
      ]));
      if (new Set(integratedIds).size !== new Set(nonemptyIds).size) throw new Error("Rebase completed but not every delegated change is an ancestor of the source workspace.");
      const conflictFiles = await this.listConflicts(input.repoRoot, exactChange(sourceChangeId));
      const descriptions = nonemptyIds.length === 0 ? [] : parseDescriptionRows(await this.run(input.repoRoot, [
        "--ignore-working-copy", "log", "--revision", changeUnion(nonemptyIds), "--no-graph", "--template", 'change_id ++ "|" ++ description.first_line() ++ "\\n"',
      ]));
      return {
        conflicted: conflictFiles.length > 0,
        conflictFiles,
        integratedChangeIds: nonemptyIds,
        undescribedChangeIds: descriptions.filter((row) => !row.description.trim()).map((row) => row.id),
        removedEmptyChangeIds: emptyIds,
        sourceChangeId,
        workspaceRemoved: true,
      };
    } catch (error) {
      throw new JjWorkspaceIntegrationError(error instanceof Error ? error.message : String(error), true);
    }
  }

  async describeChanges(
    cwd: string,
    changes: readonly { changeId: string; description: string }[],
  ): Promise<string[]> {
    for (const change of changes) {
      const description = change.description.trim();
      if (!description) throw new Error(`Description for ${change.changeId} must not be empty.`);
      await this.run(cwd, ["--ignore-working-copy", "describe", "--message", description, exactChange(change.changeId)], "write");
    }
    if (changes.length === 0) return [];
    const rows = parseDescriptionRows(await this.run(cwd, [
      "--ignore-working-copy", "log", "--revision", changeUnion(changes.map((change) => change.changeId)), "--no-graph", "--template", 'change_id ++ "|" ++ description.first_line() ++ "\\n"',
    ]));
    return rows.filter((row) => !row.description.trim()).map((row) => row.id);
  }

  async abandonChildWorkspace(input: { repoRoot: string; childWorkspace: string; childWorkspacePath: string }): Promise<void> {
    await this.run(input.repoRoot, ["workspace", "forget", input.childWorkspace], "write");
    await this.files.rm(input.childWorkspacePath);
  }

  private async verifySourceSibling(cwd: string, workspace: string, sourceChangeId: string, baseChangeId: string): Promise<void> {
    const sourceTarget = await this.workspaceTargetChangeId(cwd, `${workspace}@`);
    if (sourceTarget !== sourceChangeId) throw new Error(`Source workspace target changed during allocation: expected ${sourceChangeId}, received ${sourceTarget}.`);
    const sourceParent = line(await this.run(cwd, ["--ignore-working-copy", "log", "--revision", `parents(${exactChange(sourceChangeId)})`, "--no-graph", "--template", CHANGE_ID_TEMPLATE]), "source working-copy parent change ID");
    if (sourceParent !== baseChangeId) throw new Error(`Source workspace parent changed during allocation: expected ${baseChangeId}, received ${sourceParent}.`);
  }

  private async workspaceTargetChangeId(cwd: string, revision: string): Promise<string> {
    return line(await this.run(cwd, ["--ignore-working-copy", "log", "--revision", revision, "--no-graph", "--template", CHANGE_ID_TEMPLATE]), `${revision} workspace target change ID`);
  }

  private async listConflicts(cwd: string, revision: string): Promise<string[]> {
    try {
      return lines(await this.run(cwd, ["--ignore-working-copy", "resolve", "--list", "--revision", revision]));
    } catch (error) {
      if ((error instanceof Error ? error.message : String(error)).includes("No conflicts found at this revision")) return [];
      throw error;
    }
  }

  private async run(cwd: string, args: readonly string[], access: JjAccess = "read"): Promise<string> {
    const result = await this.executor.execute({ cwd: absolutePath(resolve(cwd)), args, access });
    if (result.kind === "success") return result.stdout;
    const detail = result.stderr.trim() || renderJjExecutionFailure(result.failure);
    throw new Error(`jj argv ${JSON.stringify(args)} failed: ${detail}`);
  }
}

function exactChange(id: string): string {
  if (!/^[a-z]{32}$/.test(id)) throw new Error(`Invalid full JJ Change ID: ${id}`);
  return `exactly(change_id(${id}), 1)`;
}
function changeUnion(ids: readonly string[]): string { return ids.map(exactChange).join(" | "); }
function parseChangeRows(output: string): Array<{ id: string; empty: boolean }> {
  return lines(output).map((row) => { const [id, state] = row.split("|", 3); if (!id || (state !== "empty" && state !== "nonempty")) throw new Error("Invalid JJ change row."); return { id, empty: state === "empty" }; });
}
function parseDescriptionRows(output: string): Array<{ id: string; description: string }> {
  return lines(output, false).map((row) => { const split = row.indexOf("|"); if (split < 1) throw new Error("Invalid JJ description row."); return { id: row.slice(0, split), description: row.slice(split + 1) }; });
}
function currentWorkspace(output: string, currentChangeId: string): string {
  const matches = lines(output).map((value) => value.split("|", 2)).filter(([, id]) => id === currentChangeId).map(([name]) => name);
  if (matches.length !== 1) throw new Error(`Unable to identify current Jujutsu workspace for change ${currentChangeId}.`);
  return matches[0]!;
}
function line(output: string, label: string): string { const value = output.trim(); if (!value || value.includes("\n")) throw new Error(`Unable to resolve ${label}.`); return value; }
function lines(output: string, trim = true): string[] { return output.split(/\r?\n/).map((value) => trim ? value.trim() : value).filter((value) => value.length > 0); }
function validateWorkspaceName(value: string): void { if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(value)) throw new Error(`Invalid child workspace name: ${value}`); }
