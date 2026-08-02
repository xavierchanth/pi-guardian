import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { JjProcessExecutor } from "../../packages/pi-tai/src/core/jj/executor.ts";
import {
  InMemoryWorkspaceRegistry,
  JjCli,
} from "../../packages/pi-tai/src/core/isolation/index.ts";
import { WorkspaceManager } from "../../packages/pi-tai/src/core/isolation/manager.ts";

const run = promisify(execFile);
const roots: string[] = [];

async function jj(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("jj", ["--no-pager", "--color=never", ...args], {
    cwd,
    env: { ...process.env, JJ_NO_PAGER: "1" },
  });
  return stdout;
}

/** A repository with one landed commit and an empty single-parent `@`. */
async function scratchRepository(): Promise<{ source: string; workspaceRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-isolation-"));
  roots.push(root);
  const source = join(root, "repo");
  await run("mkdir", ["-p", source]);
  await jj(source, "git", "init");
  await writeFile(join(source, "base.txt"), "base\n");
  await jj(source, "describe", "--message", "base commit");
  await jj(source, "new");
  return { source, workspaceRoot: join(root, "workspaces") };
}

function managerFor(source: string, workspaceRoot: string): WorkspaceManager {
  return new WorkspaceManager({
    jj: new JjCli(new JjProcessExecutor()),
    registry: new InMemoryWorkspaceRegistry(),
    sourcePath: source,
    workspaceRoot,
  });
}

async function parentsOf(cwd: string, revision: string): Promise<string[]> {
  const out = await jj(
    cwd,
    "log",
    "--revision",
    `parents(${revision})`,
    "--no-graph",
    "--template",
    'change_id ++ "\\n"',
  );
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Produces a described, non-empty change inside a workspace. */
async function commitInWorkspace(
  path: string,
  file: string,
  contents: string,
  message: string,
): Promise<void> {
  await writeFile(join(path, file), contents);
  await jj(path, "describe", "--message", message);
  await jj(path, "new");
}

describe("managed jj workspaces", () => {
  before(async () => {
    const { stdout } = await run("jj", ["--version"]);
    assert.match(stdout, /^jj 0\.43\./, "these tests pin jj 0.43.x");
    // Keep jj entirely inside the sandbox: no reads of, or writes to, the user's config.
    const configRoot = await mkdtemp(join(tmpdir(), "pi-tai-jjconfig-"));
    roots.push(configRoot);
    const configFile = join(configRoot, "config.toml");
    await writeFile(configFile, '[user]\nname = "Test"\nemail = "test@example.com"\n');
    process.env.JJ_CONFIG = configFile;
  });

  after(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });

  it("roots a new workspace at parents(@), not at the user's working copy", async () => {
    const { source, workspaceRoot } = await scratchRepository();
    const manager = managerFor(source, workspaceRoot);
    await writeFile(join(source, "wip.txt"), "user work in progress\n");

    const record = await manager.create({ label: "scout" });

    assert.deepEqual(record.baseChangeIds, await parentsOf(source, "@"));
    assert.deepEqual(await parentsOf(record.path, "@"), record.baseChangeIds);
    // The agent must not see the user's uncommitted work.
    await assert.rejects(readFile(join(record.path, "wip.txt"), "utf8"));
  });

  it("branches from every parent when the user's working copy is a merge", async () => {
    const { source, workspaceRoot } = await scratchRepository();
    const manager = managerFor(source, workspaceRoot);
    // Build a second head and merge it into `@` so the source has two parents.
    const mainHead = (
      await jj(source, "log", "--revision", "@-", "--no-graph", "--template", "change_id")
    ).trim();
    await jj(source, "new", "root()", "--message", "side branch");
    await writeFile(join(source, "side.txt"), "side\n");
    const side = (
      await jj(source, "log", "--revision", "@", "--no-graph", "--template", "change_id")
    ).trim();
    await jj(source, "new", mainHead, side);

    const parents = await parentsOf(source, "@");
    assert.equal(parents.length, 2, "precondition: source @ is a merge");

    const record = await manager.create();
    assert.deepEqual(record.baseChangeIds, parents);
    assert.deepEqual(await parentsOf(record.path, "@"), parents);
  });

  it("merges linearly when the user's working copy is empty and single-parent", async () => {
    const { source, workspaceRoot } = await scratchRepository();
    const manager = managerFor(source, workspaceRoot);
    const record = await manager.create({ label: "worker" });
    await commitInWorkspace(record.path, "feature.txt", "agent output\n", "add feature");

    const result = await manager.merge(record.id);

    assert.equal(result.kind, "merged");
    assert.equal(result.kind === "merged" && result.summary.strategy, "linear");
    assert.equal(await readFile(join(source, "feature.txt"), "utf8"), "agent output\n");
    assert.equal((await parentsOf(source, "@")).length, 1, "linear merge keeps a single-parent @");
    assert.deepEqual(await manager.list(), [], "a merged workspace leaves no record");
  });

  it("merges under a dirty working copy without disturbing the user's changes", async () => {
    const { source, workspaceRoot } = await scratchRepository();
    const manager = managerFor(source, workspaceRoot);
    const record = await manager.create({ label: "worker" });
    await commitInWorkspace(record.path, "feature.txt", "agent output\n", "add feature");
    await writeFile(join(source, "wip.txt"), "user work in progress\n");

    const result = await manager.merge(record.id);

    assert.equal(result.kind, "merged");
    assert.equal(result.kind === "merged" && result.summary.strategy, "merge-under");
    assert.equal(await readFile(join(source, "feature.txt"), "utf8"), "agent output\n");
    assert.equal(await readFile(join(source, "wip.txt"), "utf8"), "user work in progress\n");
    assert.equal(
      (await parentsOf(source, "@")).length,
      1,
      "merge-introduced redundant parent is simplified",
    );
    assert.equal(result.kind === "merged" && result.summary.parentSimplification, "applied");
    assert.equal(
      result.kind === "merged" && result.summary.parentSimplificationReason,
      "redundant-parents-removed",
    );
  });

  it("does not fail merge-under when a cosmetic topology probe fails", async () => {
    const { source, workspaceRoot } = await scratchRepository();
    const cli = new JjCli(new JjProcessExecutor());
    const manager = new WorkspaceManager({
      jj: Object.assign(Object.create(Object.getPrototypeOf(cli)), cli, {
        hasRedundantParents: async () => {
          throw new Error("simulated cosmetic failure");
        },
      }) as JjCli,
      registry: new InMemoryWorkspaceRegistry(),
      sourcePath: source,
      workspaceRoot,
    });
    const record = await manager.create();
    await commitInWorkspace(record.path, "cosmetic.txt", "kept\n", "cosmetic failure work");
    await writeFile(join(source, "dirty.txt"), "dirty\n");

    const result = await manager.merge(record.id);

    assert.equal(result.kind, "merged");
    assert.equal(result.kind === "merged" && result.summary.parentSimplification, "skipped");
    assert.equal(
      result.kind === "merged" && result.summary.parentSimplificationReason,
      "precheck-failed",
    );
    assert.equal(await readFile(join(source, "cosmetic.txt"), "utf8"), "kept\n");
  });

  it("rolls back a simplification whose ancestry postcheck fails", async () => {
    const { source, workspaceRoot } = await scratchRepository();
    const cli = new JjCli(new JjProcessExecutor());
    const manager = new WorkspaceManager({
      jj: Object.assign(Object.create(Object.getPrototypeOf(cli)), cli, {
        areAncestorsOf: async () => false,
      }) as JjCli,
      registry: new InMemoryWorkspaceRegistry(),
      sourcePath: source,
      workspaceRoot,
    });
    const record = await manager.create();
    await commitInWorkspace(record.path, "rollback.txt", "kept\n", "rollback work");
    await writeFile(join(source, "dirty.txt"), "dirty\n");

    const result = await manager.merge(record.id);

    assert.equal(result.kind, "merged", "cosmetic verification never fails the merge");
    assert.equal(result.kind === "merged" && result.summary.parentSimplification, "failed");
    assert.equal(
      result.kind === "merged" && result.summary.parentSimplificationReason,
      "postcheck-failed-rolled-back",
    );
    assert.equal(
      (await parentsOf(source, "@")).length,
      2,
      "rollback restores the unsimplified merge parents",
    );
    assert.equal(await readFile(join(source, "rollback.txt"), "utf8"), "kept\n");
  });

  it("preserves pre-existing redundant parents and skips simplification", async () => {
    const { source, workspaceRoot } = await scratchRepository();
    const base = (await parentsOf(source, "@"))[0]!;
    await writeFile(join(source, "user.txt"), "user\n");
    await jj(source, "describe", "--message", "user change");
    const descendant = (await jj(source, "log", "-r", "@", "--no-graph", "-T", "change_id")).trim();
    await jj(source, "new", base, descendant);
    const originalParents = await parentsOf(source, "@");
    assert.equal(originalParents.length, 2);

    const manager = managerFor(source, workspaceRoot);
    const record = await manager.create();
    await commitInWorkspace(record.path, "agent.txt", "agent\n", "agent change");
    await writeFile(join(source, "dirty.txt"), "dirty\n");
    const result = await manager.merge(record.id);

    assert.equal(result.kind, "merged");
    assert.equal(result.kind === "merged" && result.summary.parentSimplification, "skipped");
    assert.equal(
      result.kind === "merged" && result.summary.parentSimplificationReason,
      "pre-existing-redundancy",
    );
    const finalParents = await parentsOf(source, "@");
    assert.ok(
      originalParents.every((parent) => finalParents.includes(parent)),
      "pre-existing parent edges are preserved",
    );
  });

  it("skips simplification when the merge target has descendants and does not rewrite them", async () => {
    const { source, workspaceRoot } = await scratchRepository();
    const cli = new JjCli(new JjProcessExecutor());
    let descendantCommitAtProbe: string | undefined;
    let descendantWorkspace: string | undefined;
    const manager = new WorkspaceManager({
      jj: Object.assign(Object.create(Object.getPrototypeOf(cli)), cli, {
        hasDescendants: async () => {
          descendantCommitAtProbe = (
            await jj(descendantWorkspace!, "log", "-r", "@", "--no-graph", "-T", "commit_id")
          ).trim();
          return true;
        },
        simplifyParents: async () => {
          throw new Error("simplification must be skipped");
        },
      }) as JjCli,
      registry: new InMemoryWorkspaceRegistry(),
      sourcePath: source,
      workspaceRoot,
    });
    const record = await manager.create();
    await commitInWorkspace(record.path, "agent.txt", "agent\n", "agent change");
    await writeFile(join(source, "dirty.txt"), "dirty\n");
    descendantWorkspace = join(workspaceRoot, "observer");
    await jj(source, "workspace", "add", descendantWorkspace, "--name", "observer");
    await writeFile(join(descendantWorkspace, "observer.txt"), "observer\n");
    await jj(descendantWorkspace, "describe", "--message", "observer descendant");
    const descendantChange = (
      await jj(descendantWorkspace, "log", "-r", "@", "--no-graph", "-T", "change_id")
    ).trim();

    const result = await manager.merge(record.id);

    assert.equal(result.kind, "merged");
    assert.equal(result.kind === "merged" && result.summary.parentSimplification, "skipped");
    assert.equal(
      result.kind === "merged" && result.summary.parentSimplificationReason,
      "has-descendants",
    );
    const descendantCommitAfter = (
      await jj(source, "log", "-r", descendantChange, "--no-graph", "-T", "commit_id")
    ).trim();
    assert.equal(
      descendantCommitAfter,
      descendantCommitAtProbe,
      "the cosmetic phase does not rewrite the descendant",
    );
  });

  it("keeps the agent's work reviewable as a discrete change after merging under", async () => {
    const { source, workspaceRoot } = await scratchRepository();
    const manager = managerFor(source, workspaceRoot);
    const record = await manager.create();
    await commitInWorkspace(record.path, "a.txt", "one\n", "first agent change");
    await commitInWorkspace(record.path, "b.txt", "two\n", "second agent change");
    await writeFile(join(source, "wip.txt"), "dirty\n");

    const result = await manager.merge(record.id);

    assert.equal(result.kind, "merged");
    const summary = result.kind === "merged" ? result.summary : undefined;
    assert.equal(summary?.changeIds.length, 2);
    const descriptions = await jj(
      source,
      "log",
      "--revision",
      `${summary!.changeIds[0]}::${summary!.changeIds[1]}`,
      "--no-graph",
      "--template",
      'description.first_line() ++ "\\n"',
    );
    assert.deepEqual(
      descriptions
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .sort(),
      ["first agent change", "second agent change"],
    );
  });

  it("falls back to merging under when a linear insert would conflict", async () => {
    const { source, workspaceRoot } = await scratchRepository();
    const manager = managerFor(source, workspaceRoot);
    const record = await manager.create();
    await commitInWorkspace(record.path, "base.txt", "agent rewrite\n", "agent edits base");
    // The user lands a competing edit to the same file after the workspace forked,
    // so replaying the agent's change onto the new head cannot apply cleanly.
    await writeFile(join(source, "base.txt"), "user rewrite\n");
    await jj(source, "describe", "--message", "user edits base");
    await jj(source, "new");

    const result = await manager.merge(record.id);

    assert.equal(result.kind, "retained_conflicts");
    const summary = result.kind === "retained_conflicts" ? result.summary : undefined;
    assert.equal(summary?.strategy, "merge-under");
    assert.ok(summary!.conflictPaths.includes("base.txt"));
    assert.equal((await manager.list()).length, 1, "conflicted source custody is retained");

    await writeFile(join(source, "base.txt"), "resolved user and agent work\n");
    const retry = await manager.merge(record.id);
    assert.equal(retry.kind, "merged", "resolved target is explicitly finalized");
    assert.equal((await parentsOf(source, "@")).length, 2);
    assert.deepEqual(await manager.list(), []);
  });

  it("reports no_changes and reclaims the workspace when the agent produced nothing", async () => {
    const { source, workspaceRoot } = await scratchRepository();
    const manager = managerFor(source, workspaceRoot);
    const record = await manager.create();

    const result = await manager.merge(record.id);

    assert.equal(result.kind, "no_changes");
    assert.deepEqual(await manager.list(), []);
    assert.ok(!(await jj(source, "workspace", "list")).includes(record.name));
  });

  it("refuses to merge undescribed work", async () => {
    const { source, workspaceRoot } = await scratchRepository();
    const manager = managerFor(source, workspaceRoot);
    const record = await manager.create();
    await writeFile(join(record.path, "feature.txt"), "agent output\n");

    const result = await manager.merge(record.id);

    assert.equal(result.kind, "blocked");
    assert.match(result.kind === "blocked" ? result.reason : "", /no description/);
    assert.equal((await manager.list()).length, 1, "a blocked merge leaves the workspace intact");
  });

  it("discards a workspace and its changes", async () => {
    const { source, workspaceRoot } = await scratchRepository();
    const manager = managerFor(source, workspaceRoot);
    const record = await manager.create();
    await commitInWorkspace(record.path, "feature.txt", "agent output\n", "add feature");

    await manager.discard(record.id);

    assert.deepEqual(await manager.list(), []);
    assert.ok(!(await jj(source, "workspace", "list")).includes(record.name));
    await assert.rejects(readFile(join(source, "feature.txt"), "utf8"));
  });

  it("reclaims empty workspaces on sweep but preserves ones holding work", async () => {
    const { source, workspaceRoot } = await scratchRepository();
    const manager = managerFor(source, workspaceRoot);
    const empty = await manager.create({ label: "empty" });
    const busy = await manager.create({
      label: "busy",
      ownerId: "owner-durable-1",
      ownerDisplayId: "sa-1",
    });
    await commitInWorkspace(busy.path, "feature.txt", "agent output\n", "add feature");

    const swept = await manager.sweep();

    const byId = new Map(swept.map((entry) => [entry.id, entry]));
    assert.equal(byId.get(empty.id)?.disposition, "reclaimed");
    assert.equal(byId.get(busy.id)?.disposition, "needs_attention");
    assert.deepEqual(
      (await manager.list()).map((record) => record.id),
      [busy.id],
    );
  });

  it("leaves workspaces belonging to a running owner alone", async () => {
    const { source, workspaceRoot } = await scratchRepository();
    const manager = managerFor(source, workspaceRoot);
    const record = await manager.create({
      label: "live",
      ownerId: "owner-durable-7",
      ownerDisplayId: "sa-7",
    });

    const swept = await manager.sweep(["owner-durable-7"]);

    assert.deepEqual(
      swept.map(({ id, disposition }) => ({ id, disposition })),
      [{ id: record.id, disposition: "kept" }],
    );
    assert.deepEqual(
      (await manager.list()).map((entry) => entry.id),
      [record.id],
    );
  });

  it("cleans up the attachment when workspace creation fails after `workspace add`", async () => {
    const { source, workspaceRoot } = await scratchRepository();
    const cli = new JjCli(new JjProcessExecutor());
    const manager = new WorkspaceManager({
      jj: Object.assign(Object.create(Object.getPrototypeOf(cli)), cli, {
        changeIdAt: async (cwd: string, revision: string) => {
          if (cwd.includes("pitai-")) throw new Error("simulated post-add failure");
          return JjCli.prototype.changeIdAt.call(cli, cwd, revision);
        },
      }) as JjCli,
      registry: new InMemoryWorkspaceRegistry(),
      sourcePath: source,
      workspaceRoot,
    });

    await assert.rejects(manager.create({ label: "doomed" }), /simulated post-add failure/);

    assert.deepEqual(await manager.list(), []);
    assert.ok(!(await jj(source, "workspace", "list")).includes("pitai-doomed"));
  });
});

describe("workspace bases", () => {
  it("branches a child workspace from its parent, not from the user's copy", async () => {
    const { source, workspaceRoot } = await scratchRepository();
    const manager = managerFor(source, workspaceRoot);
    const trunk = await manager.create({ label: "trunk" });
    await commitInWorkspace(trunk.path, "trunk.txt", "trunk work\n", "trunk: groundwork");

    const child = await manager.create({ label: "agent", parent: trunk.id });

    assert.equal(child.parent, trunk.id);
    // The child sees the trunk's landed work, which it could not if it had
    // branched from the user's copy.
    assert.equal(await readFile(join(child.path, "trunk.txt"), "utf8"), "trunk work\n");
    await assert.rejects(
      readFile(join(source, "trunk.txt"), "utf8"),
      "the user's copy is untouched",
    );
  });

  it("merges a child into its trunk, leaving the user's copy alone", async () => {
    const { source, workspaceRoot } = await scratchRepository();
    const manager = managerFor(source, workspaceRoot);
    const trunk = await manager.create({ label: "trunk" });
    const child = await manager.create({ label: "agent", parent: trunk.id });
    await commitInWorkspace(child.path, "feature.txt", "agent output\n", "agent: add feature");

    const result = await manager.merge(child.id);

    assert.equal(result.kind, "merged");
    assert.equal(await readFile(join(trunk.path, "feature.txt"), "utf8"), "agent output\n");
    await assert.rejects(
      readFile(join(source, "feature.txt"), "utf8"),
      "nothing reaches the user yet",
    );
    assert.deepEqual(
      (await manager.list()).map((record) => record.id),
      [trunk.id],
    );
  });

  it("delivers a whole run to the user in one merge of the trunk", async () => {
    const { source, workspaceRoot } = await scratchRepository();
    const manager = managerFor(source, workspaceRoot);
    const trunk = await manager.create({ label: "trunk" });
    for (const name of ["one", "two"]) {
      const child = await manager.create({ label: name, parent: trunk.id });
      await commitInWorkspace(child.path, `${name}.txt`, `${name}\n`, `agent: add ${name}`);
      assert.equal((await manager.merge(child.id)).kind, "merged");
    }

    const result = await manager.merge(trunk.id);

    assert.equal(result.kind, "merged");
    assert.equal(await readFile(join(source, "one.txt"), "utf8"), "one\n");
    assert.equal(await readFile(join(source, "two.txt"), "utf8"), "two\n");
    assert.deepEqual(await manager.list(), [], "the run leaves nothing behind");
  });

  it("discards an entire run by discarding its trunk", async () => {
    const { source, workspaceRoot } = await scratchRepository();
    const manager = managerFor(source, workspaceRoot);
    const trunk = await manager.create({ label: "trunk" });
    const child = await manager.create({ label: "agent", parent: trunk.id });
    await commitInWorkspace(child.path, "feature.txt", "agent output\n", "agent: add feature");
    await manager.merge(child.id);

    await manager.discard(trunk.id);

    assert.deepEqual(await manager.list(), []);
    await assert.rejects(readFile(join(source, "feature.txt"), "utf8"));
  });
});

describe("trunk stack hygiene", () => {
  it("leaves no empty commits in the user's stack", async () => {
    const { source, workspaceRoot } = await scratchRepository();
    const manager = managerFor(source, workspaceRoot);
    const trunk = await manager.create({ label: "trunk" });
    const child = await manager.create({ label: "agent", parent: trunk.id });
    await commitInWorkspace(child.path, "feature.txt", "agent output\n", "agent: add feature");
    await manager.merge(child.id);
    await manager.merge(trunk.id);

    const empties = await jj(
      source,
      "log",
      "--revision",
      "::@ & empty() & ~root()",
      "--no-graph",
      "--template",
      'change_id ++ "\\n"',
    );
    const ids = empties
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    // `@` itself is legitimately empty; anything below it is scaffolding that leaked.
    const head = (
      await jj(source, "log", "--revision", "@", "--no-graph", "--template", "change_id")
    ).trim();
    assert.deepEqual(
      ids.filter((id) => id !== head),
      [],
      "workspace scaffolding must not reach the user's stack",
    );
  });

  it("keeps every head reachable when a trunk holds independent branches", async () => {
    const { source, workspaceRoot } = await scratchRepository();
    const manager = managerFor(source, workspaceRoot);
    const trunk = await manager.create({ label: "trunk" });

    // Force merge-under into the trunk so its content becomes a DAG with two
    // heads rather than one linear stack.
    for (const name of ["one", "two"]) {
      const child = await manager.create({ label: name, parent: trunk.id });
      await commitInWorkspace(child.path, `${name}.txt`, `${name}\n`, `agent: add ${name}`);
      assert.equal((await manager.merge(child.id)).kind, "merged");
    }

    const result = await manager.merge(trunk.id);

    assert.equal(result.kind, "merged");
    assert.equal(await readFile(join(source, "one.txt"), "utf8"), "one\n");
    assert.equal(
      await readFile(join(source, "two.txt"), "utf8"),
      "two\n",
      "the second branch must not be orphaned",
    );
  });
});

describe("multi-head trunk delivered under a dirty working copy", () => {
  it("keeps both branches reachable", async () => {
    const { source, workspaceRoot } = await scratchRepository();
    const manager = managerFor(source, workspaceRoot);
    const trunk = await manager.create({ label: "trunk" });
    // Both children are created before either merges — the concurrent case. Each
    // branches from the same trunk state, so their chains are genuinely
    // independent and the trunk ends up multi-headed.
    const children = [];
    for (const name of ["one", "two"]) {
      children.push({ name, workspace: await manager.create({ label: name, parent: trunk.id }) });
    }
    for (const { name, workspace } of children) {
      await commitInWorkspace(workspace.path, `${name}.txt`, `${name}\n`, `agent: add ${name}`);
      await manager.merge(workspace.id);
    }
    // A dirty working copy forces merge-under on the close, which is the path
    // that has to pick destinations for a multi-headed range.
    await writeFile(join(source, "wip.txt"), "user work\n");

    const result = await manager.merge(trunk.id);

    assert.equal(result.kind === "merged" && result.summary.strategy, "merge-under");
    assert.equal(await readFile(join(source, "wip.txt"), "utf8"), "user work\n");
    assert.equal(await readFile(join(source, "one.txt"), "utf8"), "one\n");
    assert.equal(
      await readFile(join(source, "two.txt"), "utf8"),
      "two\n",
      "second branch orphaned",
    );
  });
});
