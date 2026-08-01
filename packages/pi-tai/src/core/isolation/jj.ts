import { realpath } from "node:fs/promises";
import type { AbsolutePath } from "../jj/domain.ts";
import { type JjExecutor, renderJjExecutionFailure } from "../jj/executor.ts";
import { updateStaleSafely } from "../jj/stale-update.ts";
import type { ChangeEntry } from "./domain.ts";

/**
 * Typed, argv-only surface over the handful of jj commands this module needs.
 *
 * Every revision is addressed by change id through {@link exact} so that a
 * concurrent `@` move can never retarget an in-flight operation, and no caller
 * ever composes a revset from model-supplied text.
 */

const UNIT = "";
const RECORD = "";
const ENTRY_TEMPLATE = `change_id ++ "${UNIT}" ++ if(empty, "1", "0") ++ "${UNIT}" ++ if(conflict, "1", "0") ++ "${UNIT}" ++ description.first_line() ++ "${RECORD}"`;

/** Mirrors `exactChange` in ../jj/repository.ts without the branded-id plumbing. */
export function exact(changeId: string): string {
  if (!/^[k-z]{4,64}$/.test(changeId)) throw new Error(`Not a jj change id: ${changeId}`);
  return `exactly(change_id(${changeId}), 1)`;
}

/** A revset matching any one of `changeIds`, each pinned exactly. */
export function exactAny(changeIds: readonly string[]): string {
  if (!changeIds.length) throw new Error("A revset needs at least one change id.");
  return changeIds.map(exact).join(" | ");
}

export class JjCli {
  private readonly executor: JjExecutor;

  constructor(executor: JjExecutor) {
    this.executor = executor;
  }

  async read(cwd: string, args: readonly string[]): Promise<string> {
    const result = await this.executor.execute({ cwd: cwd as AbsolutePath, args, access: "read" });
    if (result.kind !== "success") {
      throw new Error(result.stderr.trim() || renderJjExecutionFailure(result.failure));
    }
    return result.stdout;
  }

  async run(cwd: string, args: readonly string[]): Promise<string> {
    const result = await this.executor.execute({ cwd: cwd as AbsolutePath, args, access: "write" });
    if (result.kind !== "success") {
      throw new Error(result.stderr.trim() || renderJjExecutionFailure(result.failure));
    }
    return `${result.stdout}${result.stderr}`;
  }

  /** Exactly one change id for a revision that must resolve to exactly one commit. */
  async changeIdAt(cwd: string, revision: string): Promise<string> {
    const out = await this.read(cwd, [
      "log",
      "--revision",
      revision,
      "--no-graph",
      "--template",
      'change_id ++ "\\n"',
    ]);
    const ids = splitLines(out);
    if (ids.length !== 1)
      throw new Error(`Expected exactly one change for ${revision}, got ${ids.length}.`);
    return ids[0]!;
  }

  /**
   * Change ids of `parents(@)` — the base a managed workspace branches from.
   * Returns more than one entry when the user's working copy is itself a merge.
   */
  async parentsOfWorkingCopy(cwd: string): Promise<string[]> {
    const out = await this.read(cwd, [
      "log",
      "--revision",
      "parents(@)",
      "--no-graph",
      "--template",
      'change_id ++ "\\n"',
    ]);
    const parents = splitLines(out);
    if (!parents.length)
      throw new Error("Source working copy has no parents; the repository is empty.");
    return parents;
  }

  async repositoryRoot(cwd: string): Promise<string> {
    const reported = (await this.read(cwd, ["root"])).trim();
    if (!reported) throw new Error("jj returned an empty repository root");
    const [actual, canonical] = await Promise.all([realpath(cwd), realpath(reported)]);
    if (actual !== canonical && !actual.startsWith(`${canonical}/`))
      throw new Error("jj repository root does not contain the requested working directory");
    return canonical;
  }

  async workspaceNames(cwd: string): Promise<string[]> {
    const out = await this.read(cwd, ["workspace", "list", "--template", 'name ++ "\\n"']);
    return splitLines(out);
  }

  /** Root-adjacent Change IDs used as path-independent repository evidence. */
  async repositoryRoots(repoRoot: string): Promise<{ roots: string[]; truncated: boolean }> {
    const out = await this.read(repoRoot, [
      "--ignore-working-copy",
      "log",
      "-r",
      "roots(all() ~ root())",
      "--limit",
      "17",
      "--no-graph",
      "-T",
      'change_id ++ "\\n"',
    ]);
    const lines = splitLines(out);
    return { roots: lines.slice(0, 16).sort(), truncated: lines.length > 16 };
  }

  /** A named attachment's head, queried without relying on its directory. */
  async workspaceHead(repoRoot: string, name: string): Promise<string | undefined> {
    if (!/^pitai-[a-z0-9-]{1,40}$/.test(name))
      throw new Error(`Invalid managed workspace name: ${name}`);
    // Listing first makes absence an explicit observation. A subsequent log
    // failure is infrastructure/repository failure and must not be downgraded.
    if (!(await this.workspaceNames(repoRoot)).includes(name)) return undefined;
    const out = await this.read(repoRoot, [
      "--ignore-working-copy",
      "log",
      "-r",
      `${name}@`,
      "--no-graph",
      "-T",
      'change_id ++ "\\n"',
    ]);
    const ids = splitLines(out);
    if (ids.length !== 1) throw new Error(`Workspace ${name} did not resolve uniquely`);
    return ids[0];
  }

  /** Distinguishes visible, divergent, hidden, and never-known Change IDs. */
  async resolveChange(
    repoRoot: string,
    changeId: string,
  ): Promise<
    | { kind: "unique"; commitId: string }
    | { kind: "divergent"; commitIds: string[] }
    | { kind: "hidden" }
    | { kind: "unknown" }
  > {
    if (!/^[k-z]{4,64}$/.test(changeId)) throw new Error(`Not a jj change id: ${changeId}`);
    const visible = splitLines(
      await this.read(repoRoot, [
        "--ignore-working-copy",
        "log",
        "-r",
        `change_id(${changeId})`,
        "--no-graph",
        "-T",
        'commit_id ++ "\\n"',
      ]),
    );
    if (visible.length === 1) return { kind: "unique", commitId: visible[0]! };
    if (visible.length > 1) return { kind: "divergent", commitIds: visible.sort() };
    let hiddenOutput: string;
    try {
      hiddenOutput = await this.read(repoRoot, [
        "--ignore-working-copy",
        "log",
        "-r",
        `all() & ${changeId}/0`,
        "--no-graph",
        "-T",
        'commit_id ++ "\\n"',
      ]);
    } catch (error) {
      // jj's commit-id lookup intentionally errors when the id has never
      // existed. Only that semantic miss is evidence; all other failures
      // (I/O, corrupt repository, timeout) remain infrastructure errors.
      if (error instanceof Error && /Revision `[^`]+\/0` doesn't exist/.test(error.message))
        return { kind: "unknown" };
      throw error;
    }
    return splitLines(hiddenOutput).length ? { kind: "hidden" } : { kind: "unknown" };
  }

  async ownedHeads(
    repoRoot: string,
    baseChangeIds: readonly string[],
    workspaceName: string,
    recordedHeads: readonly string[],
  ): Promise<string[]> {
    if (!/^pitai-[a-z0-9-]{1,40}$/.test(workspaceName))
      throw new Error(`Invalid managed workspace name: ${workspaceName}`);
    const recorded = recordedHeads.length ? ` | (${exactAny(recordedHeads)})` : "";
    const revset = `heads(((${exactAny(baseChangeIds)})..(${workspaceName}@))${recorded})`;
    return splitLines(
      await this.read(repoRoot, [
        "--ignore-working-copy",
        "log",
        "-r",
        revset,
        "--no-graph",
        "-T",
        'change_id ++ "\\n"',
      ]),
    ).sort();
  }

  /** Creates a workspace whose working copy sits on top of every id in `parentChangeIds`. */
  async workspaceAdd(
    cwd: string,
    path: string,
    name: string,
    parentChangeIds: readonly string[],
  ): Promise<void> {
    const revisions = parentChangeIds.flatMap((id) => ["--revision", exact(id)]);
    await this.run(cwd, ["workspace", "add", path, "--name", name, ...revisions]);
  }

  /**
   * Detaches a workspace. Absence is success: this is called on cleanup paths
   * where the attachment may already be gone.
   */
  async workspaceForget(cwd: string, name: string): Promise<void> {
    if (!(await this.workspaceNames(cwd)).includes(name)) return;
    await this.run(cwd, ["workspace", "forget", name]);
  }

  /**
   * Everything this workspace has added since it branched, oldest first.
   *
   * Defined against the base rather than the workspace's first commit: a
   * workspace that has had other work merged *into* it holds commits that are
   * not descendants of its own root, and a `root::head` range would miss them.
   */
  async range(
    cwd: string,
    baseChangeIds: readonly string[],
    headChangeId: string,
  ): Promise<ChangeEntry[]> {
    const revset = `(${exactAny(baseChangeIds)})..${exact(headChangeId)}`;
    const out = await this.read(cwd, [
      "log",
      "--revision",
      revset,
      "--no-graph",
      "--reversed",
      "--template",
      ENTRY_TEMPLATE,
    ]);
    return out
      .split(RECORD)
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => {
        const [changeId, empty, conflicted, description = ""] = record.split(UNIT);
        return {
          changeId: changeId!.trim(),
          description,
          empty: empty === "1",
          conflicted: conflicted === "1",
        };
      });
  }

  /**
   * The heads of a set of changes — those with no descendant inside the set.
   *
   * Concurrent subagents leave a workspace holding several independent chains,
   * and every one of them has to become a parent when that work is merged under
   * a working copy. Taking only the newest change would orphan the rest.
   */
  async headsOf(cwd: string, changeIds: readonly string[]): Promise<string[]> {
    const out = await this.read(cwd, [
      "log",
      "--revision",
      `heads(${exactAny(changeIds)})`,
      "--no-graph",
      "--template",
      'change_id ++ "\\n"',
    ]);
    return splitLines(out);
  }

  /** Paths with unresolved conflicts in the working copy at `cwd`, if any. */
  async conflictedPaths(cwd: string): Promise<string[]> {
    const result = await this.executor.execute({
      cwd: cwd as AbsolutePath,
      args: ["resolve", "--list"],
      access: "read",
    });
    // `jj resolve --list` exits non-zero precisely when there is nothing to resolve.
    if (result.kind !== "success") return [];
    return splitLines(result.stdout)
      .map((line) => line.split(/\s+/)[0]!)
      .filter(Boolean);
  }

  async hasConflicts(cwd: string, revset: string): Promise<boolean> {
    const out = await this.read(cwd, [
      "log",
      "--revision",
      revset,
      "--no-graph",
      "--template",
      'if(conflict, "x", "")',
    ]);
    return out.includes("x");
  }

  /** True when the change at `revision` carries no diff against its parents. */
  async isEmpty(cwd: string, revision: string): Promise<boolean> {
    const out = await this.read(cwd, [
      "log",
      "--revision",
      revision,
      "--no-graph",
      "--template",
      'if(empty, "1", "0")',
    ]);
    return out.trim().startsWith("1");
  }

  async describe(cwd: string, changeId: string, message: string): Promise<void> {
    await this.run(cwd, [
      "--ignore-working-copy",
      "describe",
      "--message",
      message,
      exact(changeId),
    ]);
  }

  async abandon(cwd: string, changeId: string): Promise<void> {
    await this.run(cwd, ["--ignore-working-copy", "abandon", exact(changeId)]);
  }

  /** Re-parents `@` onto `destinationChangeIds`. The workspace at `cwd` keeps its content. */
  async rebaseWorkingCopyOnto(cwd: string, destinationChangeIds: readonly string[]): Promise<void> {
    const destinations = destinationChangeIds.flatMap((id) => ["--destination", exact(id)]);
    await this.run(cwd, ["rebase", "--revisions", "@", ...destinations]);
  }

  /** Whether one direct parent is also a (strict) ancestor of another direct parent. */
  async hasRedundantParents(cwd: string, changeId: string): Promise<boolean> {
    const revision = exact(changeId);
    const out = await this.read(cwd, [
      "log",
      "--revision",
      `parents(${revision}) & ancestors(parents(${revision})-)`,
      "--limit",
      "1",
      "--no-graph",
      "--template",
      '"x"',
    ]);
    return out.includes("x");
  }

  /** True if simplifying this exact commit could rewrite anything below it. */
  async hasDescendants(cwd: string, changeId: string): Promise<boolean> {
    const revision = exact(changeId);
    const out = await this.read(cwd, [
      "log",
      "--revision",
      `(${revision}):: ~ ${revision}`,
      "--limit",
      "1",
      "--no-graph",
      "--template",
      '"x"',
    ]);
    return out.includes("x");
  }

  /** Remove redundant edges from this commit only. */
  async simplifyParents(cwd: string, changeId: string): Promise<void> {
    await this.run(cwd, ["simplify-parents", "--revision", exact(changeId)]);
  }

  /** Every supplied head must be reachable from this exact commit. */
  async areAncestorsOf(
    cwd: string,
    headIds: readonly string[],
    changeId: string,
  ): Promise<boolean> {
    const out = await this.read(cwd, [
      "log",
      "--revision",
      `(${exactAny(headIds)}) ~ ancestors(${exact(changeId)})`,
      "--limit",
      "1",
      "--no-graph",
      "--template",
      '"x"',
    ]);
    return !out.includes("x");
  }

  /**
   * Moves `changeIds` (and nothing else) to sit immediately below `@`.
   * Run against the source working copy so jj updates it in place rather than
   * leaving it stale.
   */
  async rebaseInsertBefore(cwd: string, changeIds: readonly string[]): Promise<void> {
    await this.run(cwd, ["rebase", "--revisions", exactAny(changeIds), "--insert-before", "@"]);
  }

  /** The id of the newest operation, used to bound an undo. */
  async currentOperationId(cwd: string): Promise<string> {
    const out = await this.read(cwd, [
      "--ignore-working-copy",
      "operation",
      "log",
      "--limit",
      "1",
      "--no-graph",
      "--template",
      'id ++ "\\n"',
    ]);
    return splitLines(out)[0] ?? "";
  }

  /**
   * Restores the repository to the state at `operationId`. Used to unwind a
   * speculative linear merge; restoring to a captured id is deterministic in a
   * way that undoing "the last operation" is not.
   */
  async restoreOperation(cwd: string, operationId: string): Promise<void> {
    await this.run(cwd, ["operation", "restore", operationId]);
  }

  /** `jj workspace update-stale` with the displacement guard from ../jj/stale-update.ts. */
  async updateStale(cwd: string, context: string): Promise<void> {
    await updateStaleSafely({
      context,
      location: cwd,
      read: (args) => this.read(cwd, args),
      run: (args) => this.run(cwd, args),
    });
  }
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
