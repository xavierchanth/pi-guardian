import { lstat, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const FILE_TOOL_NAMES = new Set(["read", "write", "edit", "grep", "find", "ls"]);
export const READ_ONLY_FILE_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);

export interface PathDecision {
  allowed: boolean;
  canonicalPath?: string;
  reason?: string;
}

export async function checkFileToolPath(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  tempCandidates: readonly string[] = [tmpdir(), "/tmp", "/var/tmp"],
  readCandidates: readonly string[] = defaultReadCandidates(),
): Promise<PathDecision> {
  if (!FILE_TOOL_NAMES.has(toolName)) return { allowed: true };
  const rawPath = typeof input.path === "string" ? input.path : ".";

  try {
    const workspace = await realpath(cwd);
    const allowedRoots = await canonicalRoots([workspace, ...tempCandidates]);
    const readRoots = READ_ONLY_FILE_TOOL_NAMES.has(toolName)
      ? await canonicalRoots(readCandidates)
      : [];
    const canonicalPath = await canonicalizeTarget(cwd, stripAtPrefix(rawPath));
    if ([...allowedRoots, ...readRoots].some((root) => contains(root, canonicalPath))) {
      return { allowed: true, canonicalPath };
    }
    return {
      allowed: false,
      canonicalPath,
      reason: `File tool target is outside allowed workspace, temporary, or read-only Pi/skill roots: ${canonicalPath}. Use reviewed bash only when an outside-boundary operation is explicitly authorized.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      allowed: false,
      reason: `File tool target could not be canonicalized safely: ${message}`,
    };
  }
}

export function defaultReadCandidates(): string[] {
  const agentDir = getAgentDir();
  const piPackageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const runtimePackageRoot = findPiPackageRoot(process.argv[1]);
  return [
    ...["skills", "extensions", "prompts", "themes", "npm", "git"]
      .map((directory) => join(agentDir, directory)),
    join(agentDir, "AGENTS.md"),
    join(homedir(), ".agents", "skills"),
    resolve(dirname(piPackageEntry), ".."),
    ...(runtimePackageRoot ? [runtimePackageRoot] : []),
  ];
}

function findPiPackageRoot(entry: string | undefined): string | undefined {
  if (!entry) return undefined;
  const marker = `${sep}@earendil-works${sep}pi-coding-agent${sep}`;
  const absolute = resolve(entry);
  const markerIndex = absolute.lastIndexOf(marker);
  if (markerIndex === -1) return undefined;
  return absolute.slice(0, markerIndex + marker.length - 1);
}

export async function canonicalizeCwd(cwd: string): Promise<string> {
  return realpath(cwd);
}

async function canonicalizeTarget(cwd: string, path: string): Promise<string> {
  const absolute = resolve(cwd, path);
  let existing = absolute;

  while (!(await pathExists(existing))) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error(`no existing parent for ${absolute}`);
    existing = parent;
  }

  const canonicalParent = await realpath(existing);
  return resolve(canonicalParent, relative(existing, absolute));
}

async function canonicalRoots(candidates: readonly string[]): Promise<string[]> {
  const roots = await Promise.all(candidates.map(async (candidate) => {
    try {
      return await realpath(candidate);
    } catch {
      return undefined;
    }
  }));
  return [...new Set(roots.filter((root): root is string => root !== undefined))];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function contains(root: string, target: string): boolean {
  const remainder = relative(root, target);
  return remainder === ""
    || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

function stripAtPrefix(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
