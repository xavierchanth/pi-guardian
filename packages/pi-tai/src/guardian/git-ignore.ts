import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitIgnoreStatus = "ignored" | "not-ignored" | "not-repository" | "unknown";

export interface GitIgnoreDecision {
  status: GitIgnoreStatus;
  reason?: string;
}

export async function checkGitIgnored(
  targetPath: string,
  existingAncestor: string,
): Promise<GitIgnoreDecision> {
  const probeDirectory = await directoryFor(existingAncestor);
  let repositoryRoot: string;
  try {
    const result = await runGit(probeDirectory, ["rev-parse", "--show-toplevel"]);
    repositoryRoot = result.stdout.trim();
    if (!repositoryRoot) return { status: "unknown", reason: "Git returned no repository root." };
  } catch (error) {
    if (isNotRepository(error)) return { status: "not-repository" };
    return { status: "unknown", reason: errorMessage(error) };
  }

  const relativePath = relative(repositoryRoot, targetPath);
  if (!relativePath) return { status: "not-ignored" };
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return { status: "not-repository" };
  }
  const repositoryPath = relativePath.replaceAll(sep, "/");

  try {
    await runGit(repositoryRoot, ["check-ignore", "-q", "--", repositoryPath]);
    return { status: "ignored" };
  } catch (error) {
    if (isExitCode(error, 1)) return { status: "not-ignored" };
    return { status: "unknown", reason: errorMessage(error) };
  }
}

async function directoryFor(path: string): Promise<string> {
  const stats = await lstat(path);
  return stats.isDirectory() ? path : dirname(path);
}

function runGit(cwd: string, args: readonly string[]) {
  return execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: 1024 * 1024,
  });
}

function isNotRepository(error: unknown): boolean {
  return (
    isExitCode(error, 128) && errorMessage(error).toLowerCase().includes("not a git repository")
  );
}

function isExitCode(error: unknown, code: number): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const actual: unknown = (error as Error & { code?: unknown }).code;
  return actual === code;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && "stderr" in error) {
    const stderr = (error as Error & { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}
