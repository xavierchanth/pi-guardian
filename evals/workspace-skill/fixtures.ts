import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { backendOf, type EvalCase } from "./cases.ts";
import {
  contentHash,
  seedCommittedFiles,
  seedDirtyFiles,
  stableCommitTimestamp,
  type SeedManifest,
} from "./seeded-changes.ts";

const execFileAsync = promisify(execFile);
const gitIdentity = ["-c", "user.name=Eval", "-c", "user.email=eval@example.invalid"];

export type Fixture = {
  root: string;
  repo: string;
  caseId: string;
  backend: "jj" | "git";
  sourceRevision: string;
  sourceStatus: string;
  sourceDiff: string;
  manifest: SeedManifest;
  preexistingWorktree?: string;
  completedPlannerWorkspace?: string;
};

async function command(cwd: string, file: string, args: string[]): Promise<string> {
  return (await execFileAsync(file, args, { cwd, maxBuffer: 10_000_000 })).stdout.trim();
}

async function gitCommit(repo: string, seed: string, index: number, message: string): Promise<void> {
  const date = stableCommitTimestamp(seed, index);
  await execFileAsync("git", [...gitIdentity, "commit", "-qm", message], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

async function sourceState(repo: string, backend: "jj" | "git") {
  if (backend === "jj") {
    return {
      revision: await command(repo, "jj", ["log", "-r", "@", "--no-graph", "-T", "change_id"]),
      status: await command(repo, "jj", ["status"]),
      diff: await command(repo, "jj", ["diff", "--git"]),
    };
  }
  return {
    revision: await command(repo, "git", ["rev-parse", "HEAD"]),
    status: await command(repo, "git", ["status", "--porcelain=v1"]),
    diff: await command(repo, "git", ["diff", "--binary", "HEAD"]),
  };
}

export async function createFixture(runRoot: string, spec: EvalCase, seed: string): Promise<Fixture> {
  const root = join(runRoot, spec.id);
  const repo = join(root, "repo");
  const backend = backendOf(spec);
  await mkdir(repo, { recursive: true });

  if (backend === "jj") {
    await execFileAsync("jj", ["git", "init", repo]);
    await execFileAsync("jj", ["config", "set", "--repo", "user.name", "Eval"], { cwd: repo });
    await execFileAsync("jj", ["config", "set", "--repo", "user.email", "eval@example.invalid"], { cwd: repo });
  } else {
    await execFileAsync("git", ["init", "-q"], { cwd: repo });
  }

  const manifest = await seedCommittedFiles(repo, seed);
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await gitCommit(repo, seed, 0, "seed 0");
  for (let index = 1; index < manifest.historyLength; index += 1) {
    const path = `notes/history/commit-${index}.txt`;
    const content = `${seed} history ${index}\n`;
    await writeFile(join(repo, path), content);
    manifest.entries.push({
      path,
      contentHash: contentHash(content),
      revision: "committed",
      state: "tracked",
      preservation: "unchanged",
    });
    await execFileAsync("git", ["add", path], { cwd: repo });
    await gitCommit(repo, seed, index, `seed ${index}`);
  }
  manifest.revisions = (await command(repo, "git", ["rev-list", "--reverse", "HEAD"]))
    .split(/\r?\n/)
    .filter(Boolean);

  if (backend === "jj") await execFileAsync("jj", ["new", "-m", "source working change"], { cwd: repo });
  if (spec.setup.dirty) {
    const dirty = await seedDirtyFiles(repo, `${seed}d`, backend);
    manifest.entries.push(...dirty);
    if (backend === "git") {
      const staged = dirty.find((entry) => entry.state === "staged");
      if (staged) await execFileAsync("git", ["add", staged.path], { cwd: repo });
      const committed = manifest.entries.find((entry) => entry.revision === "committed");
      if (!committed) throw new Error("Seed manifest is missing a tracked file to modify.");
      const before = await readFile(join(repo, committed.path), "utf8");
      const after = `${before}unstaged=${seed}\n`;
      await writeFile(join(repo, committed.path), after);
      manifest.entries.splice(manifest.entries.indexOf(committed), 1, {
        path: committed.path,
        contentHash: contentHash(after),
        revision: "working-copy",
        state: "unstaged",
        preservation: "source-content-excluded",
      });
    }
  }

  let completedPlannerWorkspace: string | undefined;
  if (spec.setup.kind === "jj-repository" && spec.setup.completedPlanner) {
    completedPlannerWorkspace = join(root, "managed", "eval-completed-planner");
    await mkdir(dirname(completedPlannerWorkspace), { recursive: true });
    await execFileAsync("jj", [
      "workspace", "add", completedPlannerWorkspace, "--name", "eval-completed-planner", "-r", "@-",
    ], { cwd: repo });
    for (const [index, name] of ["one", "two"].entries()) {
      const path = join(completedPlannerWorkspace, `planner-${name}.txt`);
      const content = `planner ${name} ${seed}\n`;
      await writeFile(path, content);
      manifest.auxiliary.push({
        path,
        contentHash: contentHash(content),
        state: "delegated-working-copy",
        preservation: "recoverable",
      });
      await execFileAsync("jj", ["describe", "-m", `planner ${name}`], { cwd: completedPlannerWorkspace });
      if (index === 0) await execFileAsync("jj", ["new"], { cwd: completedPlannerWorkspace });
    }
  }

  let preexistingWorktree: string | undefined;
  if (spec.setup.kind === "git-repository" && spec.setup.dirtyManagedWorktree) {
    preexistingWorktree = join(root, "managed", "eval-dirty-child");
    await mkdir(dirname(preexistingWorktree), { recursive: true });
    await execFileAsync("git", ["worktree", "add", "-q", "-b", "eval-dirty-child", preexistingWorktree], { cwd: repo });
    const recoveryPath = join(preexistingWorktree, "recover-me.txt");
    const recoveryContent = `valuable ${seed}\n`;
    await writeFile(recoveryPath, recoveryContent);
    manifest.auxiliary.push({
      path: recoveryPath,
      contentHash: contentHash(recoveryContent),
      state: "dirty-linked-worktree",
      preservation: "recoverable",
    });
  }

  const state = await sourceState(repo, backend);
  const fixture: Fixture = {
    root,
    repo,
    caseId: spec.id,
    backend,
    sourceRevision: state.revision,
    sourceStatus: state.status,
    sourceDiff: state.diff,
    manifest,
    ...(preexistingWorktree ? { preexistingWorktree } : {}),
    ...(completedPlannerWorkspace ? { completedPlannerWorkspace } : {}),
  };
  await writeFile(join(root, "fixture.json"), JSON.stringify(fixture, null, 2));
  return fixture;
}

export async function inspectFixture(fixture: Fixture) {
  const state = await sourceState(fixture.repo, fixture.backend);
  const gitWorktrees = await command(fixture.repo, "git", ["worktree", "list", "--porcelain"]);
  const gitWorktreePaths = gitWorktrees
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));

  let jjWorkspaces = "";
  let jjWorkspacePaths: string[] = [];
  if (fixture.backend === "jj") {
    jjWorkspaces = await command(fixture.repo, "jj", ["workspace", "list", "-T", 'name ++ "\\n"']);
    const names = jjWorkspaces.split(/\r?\n/).filter(Boolean);
    jjWorkspacePaths = await Promise.all(
      names.map((name) => command(fixture.repo, "jj", ["workspace", "root", "--name", name])),
    );
  }
  const recoveryContent = fixture.preexistingWorktree
    ? await readFile(join(fixture.preexistingWorktree, "recover-me.txt"), "utf8").catch(() => null)
    : undefined;
  return {
    sourceRevision: state.revision,
    sourceStatus: state.status,
    sourceDiff: state.diff,
    gitWorktrees,
    gitWorktreePaths,
    jjWorkspaces,
    jjWorkspacePaths,
    recoveryContent,
  };
}
