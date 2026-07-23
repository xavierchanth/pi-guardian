import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import {
  ScriptedJjExecutor,
  jjSuccess,
} from "../../packages/pi-tai/src/jj/executor.ts";
import { JjWorkspaceService } from "../../packages/pi-tai/src/workspaces/jj-service.ts";
import { JjWorkspacePort } from "../../packages/pi-tai/src/workspaces/jj.ts";
import { RealJjFixture } from "../support/real-jj-fixture.ts";

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
  const fixture = await RealJjFixture.create("pi-tai-jj-integration-");
  try {
    const seeded = await fixture.seed({
      changes: [{ description: "base", files: { "base.txt": "base\n" } }],
      workingCopyFiles: { "source-in-progress.txt": "source work\n" },
    });
    const sourceDiffBefore = await fixture.run(fixture.repoPath, ["diff", "--revision", "@", "--git"]);
    const port = new JjWorkspacePort(new JjWorkspaceService(fixture.executor));
    const workspace = await port.create({ cwd: fixture.repoPath, name: "worker", purpose: "delegation" });
    fixture.trackWorkspace(workspace.name, workspace.path);
    await writeFile(`${workspace.path}/one.txt`, "one\n");
    await fixture.run(workspace.path, ["describe", "--message", "first change"], "write");
    await fixture.run(workspace.path, ["new"], "write");
    await fixture.run(workspace.path, ["new"], "write");
    await writeFile(`${workspace.path}/two.txt`, "two\n");
    await fixture.run(workspace.path, ["new"], "write");

    const beforeIntegration = await fixture.snapshot();
    assert.equal(beforeIntegration.workspaces.some((item) => item.name === "worker"), true);
    const integrated = await port.integrate(workspace);
    assert.equal(integrated.conflicted, false);
    assert.equal(integrated.workspaceRemoved, true);
    assert.equal(integrated.integratedChangeIds.length, 2);
    assert.equal(integrated.removedEmptyChangeIds.length, 2);
    assert.equal(integrated.undescribedChangeIds.length, 1);
    assert.deepEqual(await port.describe(workspace, [{ changeId: integrated.undescribedChangeIds[0]!, description: "feat: add second change" }]), []);
    await assert.rejects(access(workspace.path));
    assert.doesNotMatch(await fixture.run(fixture.repoPath, ["--ignore-working-copy", "workspace", "list"]), /worker:/);

    assert.equal(await readFile(`${fixture.repoPath}/source-in-progress.txt`, "utf8"), "source work\n");
    assert.equal(await fixture.run(fixture.repoPath, ["--ignore-working-copy", "diff", "--revision", "@", "--git"]), sourceDiffBefore);
    await fixture.run(fixture.repoPath, ["workspace", "update-stale"], "write");
    assert.equal(await readFile(`${fixture.repoPath}/one.txt`, "utf8"), "one\n");
    assert.equal(await readFile(`${fixture.repoPath}/two.txt`, "utf8"), "two\n");
    assert.equal(await fixture.currentChangeId(fixture.repoPath), seeded.workingCopyChangeId);
  } catch (error) {
    const retained = await fixture.retainOnFailure("workspace integration");
    if (error instanceof Error) error.message += `\nRetained fixture: ${retained.path}`;
    throw error;
  } finally {
    await fixture.dispose();
  }
});
