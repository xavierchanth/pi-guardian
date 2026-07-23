import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  ScriptedJjExecutor,
  jjSuccess,
} from "../../packages/pi-tai/src/jj/executor.ts";
import { JjWorkspaceService } from "../../packages/pi-tai/src/workspaces/jj-service.ts";
import { JjWorkspacePort } from "../../packages/pi-tai/src/workspaces/jj.ts";

const execFileAsync = promisify(execFile);

test("JJ relocation creates a successor workspace above source @-", async () => {
  const sourceChange = "a".repeat(32);
  const sourceParent = "b".repeat(32);
  const successorRoot = "c".repeat(32);
  const source = "/repo";
  const target = "/repo/.jj/workspaces/focused";
  const executor = new ScriptedJjExecutor(async ({ cwd, args }) => {
    const command = args.join(" ");
    if (command === "root") return jjSuccess("/repo\n");
    if (command.startsWith("workspace list")) return jjSuccess(`default|${sourceChange}\n`);
    if (command.includes("--revision @ --no-graph") && cwd === target) return jjSuccess(`${successorRoot}\n`);
    if (command.includes("--revision @- --no-graph") && cwd === target) return jjSuccess(`${sourceParent}\n`);
    if (command.includes("--revision @- --no-graph")) return jjSuccess(`${sourceParent}\n`);
    if (command.includes("--revision @ --no-graph")) return jjSuccess(`${sourceChange}\n`);
    if (command.startsWith("workspace add")) return jjSuccess();
    if (command.includes("--revision default@ --no-graph")) return jjSuccess(`${sourceChange}\n`);
    if (command.includes(`parents(exactly(change_id(${sourceChange}), 1))`)) return jjSuccess(`${sourceParent}\n`);
    throw new Error(`Unexpected command: ${cwd}: ${command}`);
  });
  const service = new JjWorkspaceService(executor, { mkdir: async () => undefined, rm: async () => undefined });
  const created = await service.createRelocationWorkspace(source, "focused");
  assert.equal(created.baseChangeId, sourceParent);
  assert.equal(created.parentWorkspacePath, source);
  assert.equal(created.childRootChangeId, successorRoot);
  assert.deepEqual(executor.requests.find((call) => call.args[0] === "workspace" && call.args[1] === "add")?.args, [
    "workspace", "add", target, "--name", "focused", "--revision", `exactly(change_id(${sourceParent}), 1)`,
  ]);
  assert.ok(executor.requests.every((call) => call.args.every((arg) => !/^-([rTmB])$/.test(arg))));
});

test("JJ integration permits dirty source @, removes every empty delegated revision, and deletes the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-jj-integration-"));
  const repo = join(root, "repo");
  await execFileAsync("jj", ["git", "init", repo]);
  await execFileAsync("jj", ["config", "set", "--repo", "user.name", "Pi Tai"], { cwd: repo });
  await execFileAsync("jj", ["config", "set", "--repo", "user.email", "pi@example.invalid"], { cwd: repo });
  await writeFile(join(repo, "base.txt"), "base\n");
  await execFileAsync("jj", ["describe", "-m", "base"], { cwd: repo });
  await execFileAsync("jj", ["new"], { cwd: repo });
  await writeFile(join(repo, "source-in-progress.txt"), "source work\n");
  const sourceChangeId = (await execFileAsync("jj", ["log", "-r", "@", "--no-graph", "-T", "change_id"], { cwd: repo })).stdout.trim();
  const sourceDiffBefore = (await execFileAsync("jj", ["diff", "-r", "@", "--git"], { cwd: repo })).stdout;

  const port = new JjWorkspacePort();
  const workspace = await port.create({ cwd: repo, name: "worker", purpose: "delegation" });
  await writeFile(join(workspace.path, "one.txt"), "one\n");
  await execFileAsync("jj", ["describe", "-m", "first change"], { cwd: workspace.path });
  await execFileAsync("jj", ["new"], { cwd: workspace.path });
  await execFileAsync("jj", ["new"], { cwd: workspace.path });
  await writeFile(join(workspace.path, "two.txt"), "two\n");
  await execFileAsync("jj", ["new"], { cwd: workspace.path });

  const integrated = await port.integrate(workspace);
  assert.equal(integrated.conflicted, false);
  assert.equal(integrated.workspaceRemoved, true);
  assert.equal(integrated.integratedChangeIds.length, 2);
  assert.equal(integrated.removedEmptyChangeIds.length, 2);
  assert.equal(integrated.undescribedChangeIds.length, 1);
  assert.deepEqual(await port.describe(workspace, [{ changeId: integrated.undescribedChangeIds[0]!, description: "feat: add second change" }]), []);
  await assert.rejects(access(workspace.path));
  assert.doesNotMatch((await execFileAsync("jj", ["--ignore-working-copy", "workspace", "list"], { cwd: repo })).stdout, /worker:/);

  assert.equal(await readFile(join(repo, "source-in-progress.txt"), "utf8"), "source work\n");
  assert.equal((await execFileAsync("jj", ["--ignore-working-copy", "diff", "-r", "@", "--git"], { cwd: repo })).stdout, sourceDiffBefore);
  await execFileAsync("jj", ["workspace", "update-stale"], { cwd: repo });
  assert.equal(await readFile(join(repo, "one.txt"), "utf8"), "one\n");
  assert.equal(await readFile(join(repo, "two.txt"), "utf8"), "two\n");
  assert.equal((await execFileAsync("jj", ["log", "-r", "@", "--no-graph", "-T", "change_id"], { cwd: repo })).stdout.trim(), sourceChangeId);
});
