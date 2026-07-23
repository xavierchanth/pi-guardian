import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { JjWorkspaceService, type JjCommandRunner } from "../../packages/pi-tai/src/workspaces/jj-service.ts";
import { JjWorkspacePort } from "../../packages/pi-tai/src/workspaces/jj.ts";
import type { WorkspacePort } from "../../packages/pi-tai/src/workspaces/domain.ts";
import { GitWorktreePort } from "../../packages/pi-tai/src/workspaces/git.ts";
import { PreferredWorkspacePort } from "../../packages/pi-tai/src/workspaces/preferred.ts";

const execFileAsync = promisify(execFile);

test("JJ relocation creates a successor workspace above the source @-", async () => {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const source = "/repo";
  const target = "/repo/.jj/workspaces/focused";
  const runner: JjCommandRunner = async (cwd, args) => {
    calls.push({ cwd, args });
    const command = args.join(" ");
    if (command === "root") return "/repo\n";
    if (command.startsWith("workspace list")) return "default|source-change\n";
    if (command === "diff -r @ --summary") return "";
    if (command.includes("-r @ --no-graph") && cwd === target) return "successor-root\n";
    if (command.includes("-r @- --no-graph") && cwd === target) return "source-parent\n";
    if (command.includes("-r @- --no-graph")) return "source-parent\n";
    if (command.includes("-r @ --no-graph")) return "source-change\n";
    if (command.startsWith("workspace add")) return "";
    if (command.includes("-r default@ --no-graph")) return "source-change\n";
    if (command.includes("parents(exactly(change_id(source-change), 1))")) return "source-parent\n";
    throw new Error(`Unexpected command: ${cwd}: ${command}`);
  };
  const service = new JjWorkspaceService(runner, {
    mkdir: async () => undefined,
    rm: async () => undefined,
  });
  const created = await service.createRelocationWorkspace(source, "focused");
  assert.equal(created.baseChangeId, "source-parent");
  assert.equal(created.childRootChangeId, "successor-root");
  assert.deepEqual(
    calls.find((call) => call.args[0] === "workspace" && call.args[1] === "add")?.args,
    [
      "workspace",
      "add",
      target,
      "--name",
      "focused",
      "-r",
      "exactly(change_id(source-parent), 1)",
    ],
  );
});

test("JJ abandonment preserves a workspace with valuable working-copy changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-jj-abandon-"));
  const repo = join(root, "repo");
  await execFileAsync("jj", ["git", "init", repo]);
  await execFileAsync("jj", ["config", "set", "--repo", "user.name", "Pi Tai"], { cwd: repo });
  await execFileAsync("jj", ["config", "set", "--repo", "user.email", "pi@example.invalid"], { cwd: repo });
  await writeFile(join(repo, "base.txt"), "base\n");
  await execFileAsync("jj", ["describe", "-m", "base"], { cwd: repo });
  await execFileAsync("jj", ["new"], { cwd: repo });

  const port = new JjWorkspacePort();
  const workspace = await port.create({ cwd: repo, name: "valuable", purpose: "relocation" });
  await writeFile(join(workspace.path, "recover-me.txt"), "valuable work\n");

  assert.deepEqual(await port.abandon(workspace), { removed: false, recoveryPath: workspace.path });
  assert.equal(await readFile(join(workspace.path, "recover-me.txt"), "utf8"), "valuable work\n");
  assert.match((await execFileAsync("jj", ["workspace", "list"], { cwd: repo })).stdout, /valuable:/);
});

test("JJ planner workspace leaves dirty source work in place and later rebases a multi-change subtree", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-jj-integration-"));
  const repo = join(root, "repo");
  await execFileAsync("jj", ["git", "init", repo]);
  await execFileAsync("jj", ["config", "set", "--repo", "user.name", "Pi Tai"], { cwd: repo });
  await execFileAsync("jj", ["config", "set", "--repo", "user.email", "pi@example.invalid"], { cwd: repo });
  await writeFile(join(repo, "base.txt"), "base\n");
  await execFileAsync("jj", ["status"], { cwd: repo });
  await execFileAsync("jj", ["describe", "-m", "base"], { cwd: repo });
  await execFileAsync("jj", ["new"], { cwd: repo });
  await writeFile(join(repo, "source-in-progress.txt"), "source work\n");
  const sourceChangeId = (await execFileAsync("jj", ["log", "-r", "@", "--no-graph", "-T", "change_id"], { cwd: repo })).stdout.trim();
  const sourceBaseChangeId = (await execFileAsync("jj", ["log", "-r", "@-", "--no-graph", "-T", "change_id"], { cwd: repo })).stdout.trim();
  const sourceDiffBefore = (await execFileAsync("jj", ["diff", "-r", "@", "--git"], { cwd: repo })).stdout;
  const sourceWorkspaceBefore = (await execFileAsync("jj", ["workspace", "list", "-T", 'name ++ "\\n"'], { cwd: repo })).stdout.trim();

  const port = new JjWorkspacePort();
  const workspace = await port.create({ cwd: repo, name: "planner", purpose: "delegation" });
  if (workspace.backend !== "jj") throw new Error("Expected JJ workspace.");
  assert.equal(await readFile(join(repo, "source-in-progress.txt"), "utf8"), "source work\n");
  assert.equal(
    (await execFileAsync("jj", ["log", "-r", "@", "--no-graph", "-T", "change_id"], { cwd: repo })).stdout.trim(),
    sourceChangeId,
  );
  assert.equal((await execFileAsync("jj", ["diff", "-r", "@", "--git"], { cwd: repo })).stdout, sourceDiffBefore);
  assert.equal(workspace.baseChangeId, sourceBaseChangeId);
  assert.notEqual(workspace.rootChangeId, sourceChangeId);
  assert.equal(
    (await execFileAsync("jj", ["log", "-r", "@-", "--no-graph", "-T", "change_id"], { cwd: workspace.path })).stdout.trim(),
    sourceBaseChangeId,
  );
  await assert.rejects(access(join(workspace.path, "source-in-progress.txt")));

  await writeFile(join(workspace.path, "one.txt"), "one\n");
  await execFileAsync("jj", ["status"], { cwd: workspace.path });
  await execFileAsync("jj", ["describe", "-m", "first planner change"], { cwd: workspace.path });
  await execFileAsync("jj", ["new"], { cwd: workspace.path });
  await writeFile(join(workspace.path, "two.txt"), "two\n");
  await execFileAsync("jj", ["status"], { cwd: workspace.path });
  await execFileAsync("jj", ["describe", "-m", "second planner change"], { cwd: workspace.path });
  await execFileAsync("jj", ["new"], { cwd: workspace.path });
  const delegatedTipChangeId = (await execFileAsync("jj", ["log", "-r", "@", "--no-graph", "-T", "change_id"], { cwd: workspace.path })).stdout.trim();

  assert.deepEqual(await port.integrate(workspace), { conflicted: false, conflictFiles: [] });
  assert.equal(await readFile(join(repo, "source-in-progress.txt"), "utf8"), "source work\n");
  assert.equal((await execFileAsync("jj", ["workspace", "list", "-T", 'name ++ "\\n"'], { cwd: repo })).stdout.split(/\r?\n/).find((name) => name === sourceWorkspaceBefore), sourceWorkspaceBefore);
  assert.equal((await execFileAsync("jj", ["log", "-r", "@", "--no-graph", "-T", "change_id"], { cwd: repo })).stdout.trim(), sourceChangeId);
  assert.equal((await execFileAsync("jj", ["diff", "-r", "@", "--git"], { cwd: repo })).stdout, sourceDiffBefore);
  assert.equal((await execFileAsync("jj", ["log", "-r", "@-", "--no-graph", "-T", "change_id"], { cwd: repo })).stdout.trim(), delegatedTipChangeId);
  assert.equal((await execFileAsync("jj", ["log", "-r", `parents(change_id(${workspace.rootChangeId}))`, "--no-graph", "-T", "change_id"], { cwd: repo })).stdout.trim(), sourceBaseChangeId);
  const serialChangeIds = (await execFileAsync("jj", [
    "log",
    "-r",
    `change_id(${sourceBaseChangeId})::change_id(${sourceChangeId})`,
    "--no-graph",
    "-T",
    'change_id ++ "\\n"',
  ], { cwd: repo })).stdout.trim().split(/\r?\n/);
  assert.equal(serialChangeIds[0], sourceChangeId);
  assert.equal(serialChangeIds.at(-1), sourceBaseChangeId);
  assert.equal(serialChangeIds.length, 5, "base, three delegated changes, and dirty source @ form one serial range");
  assert.equal(await readFile(join(repo, "one.txt"), "utf8"), "one\n");
  assert.equal(await readFile(join(repo, "two.txt"), "utf8"), "two\n");
  const history = (await execFileAsync("jj", [
    "log",
    "-r",
    `change_id(${workspace.rootChangeId})::default@`,
    "--no-graph",
    "-T",
    'description.first_line() ++ "\\n"',
  ], { cwd: repo })).stdout;
  assert.match(history, /first planner change/);
  assert.match(history, /second planner change/);

  await port.finalize(workspace);
  await assert.rejects(access(workspace.path));
  assert.doesNotMatch((await execFileAsync("jj", ["workspace", "list"], { cwd: repo })).stdout, /planner:/);
});

test("preferred backend selects JJ before mutation and falls back to Git only when unavailable", async () => {
  const calls: string[] = [];
  const git = {
    kind: "git",
    probe: async () => ({ available: true }),
    create: async () => {
      calls.push("git-create");
      return { backend: "git", purpose: "delegation" };
    },
  } as unknown as WorkspacePort;
  const unavailableJj = {
    kind: "jj",
    probe: async () => ({ available: false, reason: "not jj" }),
  } as unknown as WorkspacePort;
  await new PreferredWorkspacePort(unavailableJj, git).create({ cwd: "/repo", name: "task", purpose: "delegation" });
  assert.deepEqual(calls, ["git-create"]);

  const failingJj = {
    kind: "jj",
    probe: async () => ({ available: true }),
    create: async () => {
      calls.push("jj-create");
      throw new Error("partial JJ failure");
    },
  } as unknown as WorkspacePort;
  await assert.rejects(
    new PreferredWorkspacePort(failingJj, git).create({ cwd: "/repo", name: "task-two", purpose: "delegation" }),
    /partial JJ failure/,
  );
  assert.deepEqual(calls, ["git-create", "jj-create"]);
});

test("Git relocation leaves dirty source work in place and refuses to abandon dirty child work", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-git-worktree-"));
  const repo = join(root, "repo");
  const managed = join(root, "managed");
  await mkdir(repo);
  await execFileAsync("git", ["init", "-q"], { cwd: repo });
  await writeFile(join(repo, "file.txt"), "base\n");
  await execFileAsync("git", ["add", "file.txt"], { cwd: repo });
  await execFileAsync("git", ["-c", "user.name=Pi Tai", "-c", "user.email=pi@example.invalid", "commit", "-qm", "base"], { cwd: repo });
  await writeFile(join(repo, "source-only.txt"), "source work\n");

  const port = new GitWorktreePort(managed);
  const workspace = await port.create({ cwd: repo, name: "focused", purpose: "relocation" });
  assert.equal(workspace.backend, "git");
  assert.equal(workspace.backend === "git" && workspace.branch, "pi-tai/relocation/focused");
  await access(workspace.path);
  assert.equal(await readFile(join(repo, "source-only.txt"), "utf8"), "source work\n");
  await assert.rejects(access(join(workspace.path, "source-only.txt")));
  assert.equal((await port.captureTip(workspace)).clean, true);

  await writeFile(join(workspace.path, "file.txt"), "dirty\n");
  assert.deepEqual(await port.abandon(workspace), { removed: false, recoveryPath: workspace.path });
  await execFileAsync("git", ["reset", "--hard", "-q"], { cwd: workspace.path });
  assert.deepEqual(await port.abandon(workspace), { removed: true });
});

test("Git delegated work preserves commits through reviewed merge and finalization", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-git-delegation-"));
  const repo = join(root, "repo");
  const managed = join(root, "managed");
  await mkdir(repo);
  await execFileAsync("git", ["init", "-q"], { cwd: repo });
  await writeFile(join(repo, "file.txt"), "base\n");
  await execFileAsync("git", ["add", "file.txt"], { cwd: repo });
  const identity = ["-c", "user.name=Pi Tai", "-c", "user.email=pi@example.invalid"];
  await execFileAsync("git", [...identity, "commit", "-qm", "base"], { cwd: repo });

  const port = new GitWorktreePort(managed);
  const workspace = await port.create({ cwd: repo, name: "child", purpose: "delegation" });
  await writeFile(join(workspace.path, "file.txt"), "child\n");
  await execFileAsync("git", ["add", "file.txt"], { cwd: workspace.path });
  await execFileAsync("git", [...identity, "commit", "-qm", "child change"], { cwd: workspace.path });
  assert.equal((await port.captureTip(workspace)).clean, true);

  assert.deepEqual(await port.integrate(workspace), { conflicted: false, conflictFiles: [] });
  await execFileAsync("git", ["config", "user.name", "Pi Tai"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "pi@example.invalid"], { cwd: repo });
  await port.finalize(workspace);
  await assert.rejects(access(workspace.path));
  const history = (await execFileAsync("git", ["log", "--oneline", "--all"], { cwd: repo })).stdout;
  assert.match(history, /child change/);
  assert.match(history, /merge delegated workspace child/);
});
