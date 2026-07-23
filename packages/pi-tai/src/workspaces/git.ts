import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  requireGitWorkspace,
  type WorkspaceAbandonResult,
  type WorkspaceAttachment,
  type WorkspaceAvailability,
  type WorkspaceCreateRequest,
  type WorkspaceIntegrationResult,
  type WorkspacePort,
  type WorkspaceTip,
} from "./domain.ts";

const execFileAsync = promisify(execFile);
export type GitCommandRunner = (cwd: string, args: string[]) => Promise<string>;

export class GitWorktreePort implements WorkspacePort {
  readonly kind = "git" as const;
  private readonly root: string;
  private readonly run: GitCommandRunner;

  constructor(root: string, run: GitCommandRunner = runGitCommand) {
    this.root = root;
    this.run = run;
  }

  async probe(cwd: string): Promise<WorkspaceAvailability> {
    try {
      const repoRoot = line(await this.run(cwd, ["rev-parse", "--show-toplevel"]), "Git repository root");
      return { available: true, repoRoot };
    } catch {
      return { available: false, reason: "The cwd is not a Git repository or git is unavailable." };
    }
  }

  async create(request: WorkspaceCreateRequest): Promise<WorkspaceAttachment> {
    validateName(request.name);
    const repoRoot = line(await this.run(request.cwd, ["rev-parse", "--show-toplevel"]), "Git repository root");
    const baseCommit = line(await this.run(repoRoot, ["rev-parse", "HEAD"]), "Git base commit");
    const repoKey = createHash("sha256").update(resolve(repoRoot)).digest("hex").slice(0, 16);
    const parent = join(this.root, repoKey);
    const path = join(parent, request.name);
    const branch = `pi-tai/${request.purpose}/${request.name}`;
    await mkdir(parent, { recursive: true, mode: 0o700 });
    try {
      await this.run(repoRoot, ["worktree", "add", "-b", branch, path, baseCommit]);
    } catch (error) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return {
      backend: "git",
      purpose: request.purpose,
      repoRoot,
      sourceWorktree: repoRoot,
      baseCommit,
      branch,
      name: request.name,
      path,
    };
  }

  async captureTip(workspace: WorkspaceAttachment): Promise<WorkspaceTip> {
    const git = requireGitWorkspace(workspace);
    const status = await this.run(git.path, ["status", "--porcelain"]);
    const tip = line(await this.run(git.path, ["rev-parse", "HEAD"]), "Git worktree tip");
    return { id: tip, clean: status.trim().length === 0 };
  }

  async integrate(workspace: WorkspaceAttachment): Promise<WorkspaceIntegrationResult> {
    const git = requireGitWorkspace(workspace);
    if (git.purpose !== "delegation") throw new Error("Standalone Git relocation has no parent integration step.");
    const sourceDirty = await this.run(git.sourceWorktree, ["status", "--porcelain"]);
    if (sourceDirty.trim()) throw new Error("Git child integration requires a clean parent checkout.");
    try {
      await this.run(git.sourceWorktree, ["merge", "--no-ff", "--no-commit", git.branch]);
    } catch (error) {
      const conflicts = await this.run(git.sourceWorktree, ["diff", "--name-only", "--diff-filter=U"])
        .catch(() => "");
      const conflictFiles = lines(conflicts);
      if (conflictFiles.length > 0) return { conflicted: true, conflictFiles };
      throw error;
    }
    return { conflicted: false, conflictFiles: [] };
  }

  async finalize(workspace: WorkspaceAttachment): Promise<void> {
    const git = requireGitWorkspace(workspace);
    if (git.purpose !== "delegation") throw new Error("Cannot finalize an active standalone Git worktree.");
    const conflicts = await this.run(git.sourceWorktree, ["diff", "--name-only", "--diff-filter=U"]);
    if (conflicts.trim()) throw new Error("Cannot finalize Git integration while conflicts remain.");
    const mergeHead = await this.run(git.sourceWorktree, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])
      .catch(() => "");
    if (mergeHead.trim()) {
      await this.run(git.sourceWorktree, ["commit", "-m", `merge delegated workspace ${git.name}`]);
    }
    const dirty = await this.run(git.path, ["status", "--porcelain"]);
    if (dirty.trim()) throw new Error(`Cannot remove dirty child worktree; recover it at ${git.path}.`);
    await this.run(git.repoRoot, ["worktree", "remove", git.path]);
  }

  async abandon(workspace: WorkspaceAttachment): Promise<WorkspaceAbandonResult> {
    const git = requireGitWorkspace(workspace);
    const dirty = await this.run(git.path, ["status", "--porcelain"]);
    if (dirty.trim()) return { removed: false, recoveryPath: git.path };
    await this.run(git.repoRoot, ["worktree", "remove", git.path]);
    return { removed: true };
  }
}

export async function runGitCommand(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return result.stdout;
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(`git ${args.join(" ")} failed: ${failure.stderr?.trim() || failure.message}`);
  }
}

function validateName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(name)) throw new Error(`Invalid Git worktree name: ${name}`);
}

function line(output: string, label: string): string {
  const value = output.trim();
  if (!value || value.includes("\n")) throw new Error(`Unable to resolve ${label}.`);
  return value;
}

function lines(output: string): string[] {
  return output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}
