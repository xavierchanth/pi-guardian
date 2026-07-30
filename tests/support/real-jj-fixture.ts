import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  absolutePath,
  changeId,
  type AbsolutePath,
  type ChangeId,
} from "../../packages/pi-tai/src/jj/domain.ts";
import {
  JjProcessExecutor,
  renderJjExecutionFailure,
  type JjAccess,
  type JjExecutionRequest,
  type JjExecutionResult,
  type JjExecutor,
  type JjProbeResult,
} from "../../packages/pi-tai/src/jj/executor.ts";

const CHANGE_TEMPLATE =
  'change_id ++ "|" ++ parents.map(|c| c.change_id()).join(",") ++ "|" ++ if(empty, "empty", "nonempty") ++ "|" ++ if(conflict, "conflicted", "clean") ++ "|" ++ description.first_line() ++ "\\n"';
const WORKSPACE_TEMPLATE = 'name ++ "|" ++ target.change_id() ++ "\\n"';
const TEST_CONFIG = [
  "--config",
  'user.name="Pi-Tai Test"',
  "--config",
  'user.email="pi-tai@example.invalid"',
  "--config",
  "signing.behavior=drop",
] as const;

export interface JjFixtureSnapshot {
  operationId: string;
  workspaces: Array<{ name: string; targetChangeId: ChangeId; path: string }>;
  changes: Array<{
    changeId: ChangeId;
    parentChangeIds: ChangeId[];
    description: string;
    empty: boolean;
    conflicted: boolean;
    changedPaths: string[];
  }>;
  workingCopies: Array<{ workspace: string; changeId: ChangeId; contentHash: string }>;
}

export interface JjSeedChange {
  description: string;
  files: Readonly<Record<string, string>>;
}

export interface JjSeedPlan {
  changes?: readonly JjSeedChange[];
  workingCopyFiles?: Readonly<Record<string, string>>;
}

export interface JjSeedReceipt {
  changeIds: ChangeId[];
  workingCopyChangeId: ChangeId;
}

export class RealJjFixture {
  readonly root: AbsolutePath;
  readonly repoPath: AbsolutePath;
  readonly executor: JjExecutor;
  private readonly workspacePaths = new Map<string, AbsolutePath>();
  private retained = false;

  private constructor(root: AbsolutePath, repoPath: AbsolutePath, executor: JjExecutor) {
    this.root = root;
    this.repoPath = repoPath;
    this.executor = executor;
    this.workspacePaths.set("default", repoPath);
  }

  static async create(prefix = "pi-tai-real-jj-"): Promise<RealJjFixture> {
    const root = absolutePath(await mkdtemp(join(tmpdir(), prefix)));
    const repoPath = absolutePath(join(root, "repo"));
    const processExecutor = new JjProcessExecutor({
      environment: { ...process.env, JJ_CONFIG: "" },
    });
    const executor = new FixtureJjExecutor(processExecutor);
    const fixture = new RealJjFixture(root, repoPath, executor);
    await fixture.run(root, ["git", "init", repoPath], "write");
    return fixture;
  }

  async seed(plan: JjSeedPlan): Promise<JjSeedReceipt> {
    const changeIds: ChangeId[] = [];
    for (const seed of plan.changes ?? []) {
      await this.writeFiles(this.repoPath, seed.files);
      await this.run(this.repoPath, ["describe", "--message", seed.description], "write");
      changeIds.push(await this.currentChangeId(this.repoPath));
      await this.run(this.repoPath, ["new"], "write");
    }
    await this.writeFiles(this.repoPath, plan.workingCopyFiles ?? {});
    return { changeIds, workingCopyChangeId: await this.currentChangeId(this.repoPath) };
  }

  async addWorkspace(
    name: string,
    revision: string,
    path = join(this.root, "workspaces", name),
  ): Promise<AbsolutePath> {
    const workspacePath = absolutePath(path);
    await mkdir(join(this.root, "workspaces"), { recursive: true });
    await this.run(
      this.repoPath,
      ["workspace", "add", workspacePath, "--name", name, "--revision", revision],
      "write",
    );
    this.workspacePaths.set(name, workspacePath);
    return workspacePath;
  }

  trackWorkspace(name: string, path: string): void {
    this.workspacePaths.set(name, absolutePath(path));
  }

  async run(cwd: string, args: readonly string[], access: JjAccess = "read"): Promise<string> {
    const result = await this.executor.execute({ cwd: absolutePath(cwd), args, access });
    if (result.kind === "success") return result.stdout;
    throw new Error(`${renderJjExecutionFailure(result.failure)} ${result.stderr.trim()}`.trim());
  }

  async currentChangeId(cwd: string): Promise<ChangeId> {
    const output = await this.run(cwd, [
      "log",
      "--revision",
      "@",
      "--no-graph",
      "--template",
      'change_id ++ "\\n"',
    ]);
    return changeId(singleLine(output, "working-copy Change ID"));
  }

  async snapshot(): Promise<JjFixtureSnapshot> {
    const operationId = singleLine(
      await this.run(this.repoPath, [
        "--ignore-working-copy",
        "operation",
        "log",
        "--limit",
        "1",
        "--no-graph",
        "--template",
        'id ++ "\\n"',
      ]),
      "operation ID",
    );
    const workspaceRows = rows(
      await this.run(this.repoPath, [
        "--ignore-working-copy",
        "workspace",
        "list",
        "--template",
        WORKSPACE_TEMPLATE,
      ]),
    )
      .map((row) => {
        const [name, id] = row.split("|");
        if (!name || !id) throw new Error(`Invalid workspace row: ${row}`);
        const path = this.workspacePaths.get(name);
        if (!path) throw new Error(`Fixture does not know path for workspace ${name}.`);
        return { name, targetChangeId: changeId(id), path };
      })
      .sort((left, right) => left.name.localeCompare(right.name));

    const changes = [];
    for (const row of rows(
      await this.run(this.repoPath, [
        "--ignore-working-copy",
        "log",
        "--revision",
        "all()",
        "--no-graph",
        "--template",
        CHANGE_TEMPLATE,
      ]),
    )) {
      const [id, parents, state, conflict, description = ""] = row.split("|", 5);
      if (
        !id ||
        (state !== "empty" && state !== "nonempty") ||
        (conflict !== "clean" && conflict !== "conflicted")
      ) {
        throw new Error(`Invalid change row: ${row}`);
      }
      const exact = `exactly(change_id(${changeId(id)}), 1)`;
      const changedPaths = rows(
        await this.run(this.repoPath, [
          "--ignore-working-copy",
          "diff",
          "--revision",
          exact,
          "--name-only",
        ]),
      ).sort();
      changes.push({
        changeId: changeId(id),
        parentChangeIds: parents ? parents.split(",").map(changeId) : [],
        description,
        empty: state === "empty",
        conflicted: conflict === "conflicted",
        changedPaths,
      });
    }
    changes.sort((left, right) => left.changeId.localeCompare(right.changeId));

    const workingCopies = [];
    for (const workspace of workspaceRows) {
      workingCopies.push({
        workspace: workspace.name,
        changeId: await this.currentChangeId(workspace.path),
        contentHash: await hashWorkingCopy(workspace.path),
      });
    }
    workingCopies.sort((left, right) => left.workspace.localeCompare(right.workspace));
    return { operationId, workspaces: workspaceRows, changes, workingCopies };
  }

  async retainOnFailure(testName: string): Promise<{ path: string; operationLog: string }> {
    this.retained = true;
    const marker = join(this.root, "RETAINED.txt");
    await writeFile(marker, `${testName}\n`);
    const operationLog = await this.run(this.repoPath, [
      "--ignore-working-copy",
      "operation",
      "log",
      "--no-graph",
    ]);
    await writeFile(join(this.root, "operation-log.txt"), operationLog);
    return { path: this.root, operationLog };
  }

  async dispose(): Promise<void> {
    if (!this.retained) await rm(this.root, { recursive: true, force: true });
  }

  private async writeFiles(cwd: string, files: Readonly<Record<string, string>>): Promise<void> {
    for (const [relativePath, content] of Object.entries(files)) {
      if (
        !relativePath ||
        relativePath.startsWith("/") ||
        relativePath.split(/[\\/]/).includes("..")
      ) {
        throw new Error(`Invalid fixture-relative path: ${relativePath}`);
      }
      const path = join(cwd, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
  }
}

class FixtureJjExecutor implements JjExecutor {
  private readonly delegate: JjExecutor;

  constructor(delegate: JjExecutor) {
    this.delegate = delegate;
  }

  probe(signal?: AbortSignal): Promise<JjProbeResult> {
    return this.delegate.probe(signal);
  }

  execute(request: JjExecutionRequest): Promise<JjExecutionResult> {
    return this.delegate.execute({ ...request, args: [...TEST_CONFIG, ...request.args] });
  }
}

async function hashWorkingCopy(root: string): Promise<string> {
  const hash = createHash("sha256");
  const files = await listFiles(root);
  for (const path of files) {
    const name = relative(root, path);
    hash
      .update(name)
      .update("\0")
      .update(await readFile(path))
      .update("\0");
  }
  return hash.digest("hex");
}

async function listFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".jj" || entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
    }
  }
  await visit(root);
  return output.sort((left, right) => left.localeCompare(right));
}

function rows(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function singleLine(output: string, label: string): string {
  const values = rows(output);
  if (values.length !== 1) throw new Error(`Unable to resolve ${label}.`);
  return values[0]!;
}
