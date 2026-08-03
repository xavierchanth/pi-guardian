import { lstat, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveStoragePaths } from "../storage/paths.ts";
import { checkGitIgnored } from "./git-ignore.ts";

export const FILE_TOOL_NAMES = new Set(["read", "write", "edit", "grep", "find", "ls"]);
export const READ_ONLY_FILE_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);

export type PathDecisionKind = "allow" | "review" | "deny";
export type PathReviewTrigger =
  | "gitignored"
  | "git-status-unknown"
  | "sensitive-path"
  | "vcs-metadata"
  | "pi-credential"
  | "pi-session"
  | "protected-descendant";

export interface PathReviewEvidence {
  canonicalPath: string;
  requestedPath: string;
  triggers: PathReviewTrigger[];
  detail: string;
}

export interface PathDecision {
  kind: PathDecisionKind;
  canonicalPath?: string;
  reason?: string;
  evidence?: PathReviewEvidence;
}

interface CanonicalTarget {
  canonicalPath: string;
  lexicalPath: string;
  existingAncestor: string;
}

export async function checkFileToolPath(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  tempCandidates: readonly string[] = [tmpdir(), "/tmp", "/var/tmp"],
  readCandidates: readonly string[] = defaultReadCandidates(),
  agentDirectory: string = getAgentDir(),
): Promise<PathDecision> {
  if (!FILE_TOOL_NAMES.has(toolName)) return { kind: "allow" };
  const rawPath = typeof input.path === "string" ? input.path : ".";
  const requestedPath = stripAtPrefix(rawPath);

  try {
    const workspace = await realpath(cwd);
    const lexicalWorkspace = resolve(cwd);
    const allowedRoots = await canonicalRoots([workspace, ...tempCandidates]);
    const readRoots = READ_ONLY_FILE_TOOL_NAMES.has(toolName)
      ? await canonicalRoots(readCandidates)
      : [];
    const canonicalAgentDirectory = await canonicalRoot(agentDirectory);
    const lexicalAgentDirectory = resolve(agentDirectory);
    const target = await canonicalizeTarget(cwd, requestedPath);

    // Task bodies are human-owned immutable records, not an agent file API.
    // Resolve from XDG on every decision so no lexical alias or legacy agent
    // directory can bypass the durable storage boundary.
    const taskRoot = resolveStoragePaths().taskBodies;
    const canonicalTaskRoot = await canonicalRoot(taskRoot);
    if (
      canonicalTaskRoot &&
      (contains(taskRoot, target.lexicalPath) || contains(canonicalTaskRoot, target.canonicalPath))
    ) {
      return READ_ONLY_FILE_TOOL_NAMES.has(toolName)
        ? review(
            target,
            requestedPath,
            "sensitive-path",
            "The target is private human-owned task body storage.",
          )
        : deny(target.canonicalPath, "Built-in file tools cannot mutate task body storage.");
    }

    if (
      contains(lexicalWorkspace, target.lexicalPath) &&
      !contains(workspace, target.canonicalPath)
    ) {
      return deny(
        target.canonicalPath,
        `File tool target escapes the workspace through a symlink: ${target.canonicalPath}.`,
      );
    }

    const lexicallyInAgentDirectory = contains(lexicalAgentDirectory, target.lexicalPath);
    if (
      canonicalAgentDirectory &&
      lexicallyInAgentDirectory &&
      !contains(canonicalAgentDirectory, target.canonicalPath)
    ) {
      return deny(
        target.canonicalPath,
        `File tool target escapes Pi agent state through a symlink: ${target.canonicalPath}.`,
      );
    }
    if (
      canonicalAgentDirectory &&
      (lexicallyInAgentDirectory || contains(canonicalAgentDirectory, target.canonicalPath))
    ) {
      const logicalPath = lexicallyInAgentDirectory
        ? resolve(canonicalAgentDirectory, relative(lexicalAgentDirectory, target.lexicalPath))
        : target.canonicalPath;
      return classifyPiAgentPath(
        toolName,
        target,
        requestedPath,
        canonicalAgentDirectory,
        logicalPath,
      );
    }

    const withinWritableBoundary = allowedRoots.some((root) =>
      contains(root, target.canonicalPath),
    );
    const withinReadBoundary = readRoots.some((root) => contains(root, target.canonicalPath));
    if (!withinWritableBoundary && !withinReadBoundary) {
      return deny(
        target.canonicalPath,
        `File tool target is outside allowed workspace, temporary, or read-only Pi/skill roots: ${target.canonicalPath}. Use reviewed bash only when an outside-boundary operation is explicitly authorized.`,
      );
    }

    const readBoundary = readRoots.find((root) => contains(root, target.canonicalPath));
    const sensitive = sensitiveTrigger(target, readBoundary ?? workspace);
    if (sensitive) {
      return review(target, requestedPath, sensitive.trigger, sensitive.detail);
    }

    // Read-only roots — packaged skills, prompts, themes, and Pi's own installed
    // files — are reference material the agent is expected to read. Git ignore
    // status says nothing useful about them: a package directory is ignored by
    // construction and the agent directory is usually not a repository at all,
    // so the check would send every such read to review for no security gain.
    // This holds even when the root also sits inside the workspace, which is the
    // usual case for a locally installed Pi package under node_modules.
    if (withinReadBoundary) {
      return { kind: "allow", canonicalPath: target.canonicalPath };
    }

    // A checkout may be managed by JJ without a colocated .git directory; its
    // dependency tree is still ignored private material rather than an
    // automatic-read exception.
    if (contains(join(workspace, "node_modules"), target.canonicalPath)) {
      return review(
        target,
        requestedPath,
        "gitignored",
        "The dependency tree is ignored by the checkout and requires Guardian review.",
      );
    }

    const ignoreDecision = await classifyGitIgnore(target);
    if (ignoreDecision) {
      return review(target, requestedPath, ignoreDecision.trigger, ignoreDecision.detail);
    }

    return { kind: "allow", canonicalPath: target.canonicalPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "deny",
      reason: `File tool target could not be canonicalized safely: ${message}`,
    };
  }
}

export function defaultReadCandidates(): string[] {
  const agentDir = getAgentDir();
  const piPackageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  return [
    piTaiPackageRoot(),
    ...["skills", "extensions", "prompts", "themes", "npm", "git"].map((directory) =>
      join(agentDir, directory),
    ),
    ...["AGENTS.md", "settings.json", "trust.json", "models-store.json"].map((file) =>
      join(agentDir, file),
    ),
    join(homedir(), ".agents", "skills"),
    resolve(dirname(piPackageEntry), ".."),
  ];
}

async function classifyPiAgentPath(
  toolName: string,
  target: CanonicalTarget,
  requestedPath: string,
  agentDirectory: string,
  logicalPath: string,
): Promise<PathDecision> {
  if (!READ_ONLY_FILE_TOOL_NAMES.has(toolName)) {
    return deny(
      target.canonicalPath,
      `Built-in file tools cannot modify Pi agent state: ${target.canonicalPath}. Use reviewed bash only when the change is explicitly authorized.`,
    );
  }

  const authPath = join(agentDirectory, "auth.json");
  const modelsPath = join(agentDirectory, "models.json");
  const sessionsPath = join(agentDirectory, "sessions");
  // Retired and current Pi-Tai state can contain private session-derived data.
  const piTaiPrivatePath = join(agentDirectory, "pi-tai");
  if (logicalPath === authPath || logicalPath === modelsPath) {
    return review(
      target,
      requestedPath,
      "pi-credential",
      "The target is Pi authentication or model-provider state and may contain credentials.",
    );
  }
  if (contains(sessionsPath, logicalPath)) {
    return review(
      target,
      requestedPath,
      "pi-session",
      "The target is Pi session history and may contain unrelated private conversation or tool data.",
    );
  }
  if (contains(piTaiPrivatePath, logicalPath)) {
    return review(
      target,
      requestedPath,
      "pi-session",
      "The target is private Pi-Tai state and may contain session-derived data.",
    );
  }
  if (
    (toolName === "grep" || toolName === "find") &&
    [authPath, modelsPath, sessionsPath, piTaiPrivatePath].some((protectedPath) =>
      contains(logicalPath, protectedPath),
    )
  ) {
    return review(
      target,
      requestedPath,
      "protected-descendant",
      "The aggregate search can traverse Pi credentials or session history.",
    );
  }

  const sensitive = sensitiveTrigger(target, agentDirectory);
  if (sensitive) {
    return review(target, requestedPath, sensitive.trigger, sensitive.detail);
  }
  // Credentials, model state, and session history are handled above. What is
  // left is the agent's own configuration and packaged resources, which are
  // read freely; the agent directory is not a repository, so a git ignore check
  // here only ever yields "unknown" and an unhelpful review.
  return { kind: "allow", canonicalPath: target.canonicalPath };
}

async function classifyGitIgnore(
  target: CanonicalTarget,
): Promise<{ trigger: PathReviewTrigger; detail: string } | undefined> {
  const paths = [...new Set([target.lexicalPath, target.canonicalPath])];
  for (const path of paths) {
    const decision = await checkGitIgnored(path, target.existingAncestor);
    if (decision.status === "ignored") {
      return {
        trigger: "gitignored",
        detail: "Git ignores the requested target, so its contents require Guardian review.",
      };
    }
    if (decision.status === "unknown") {
      return {
        trigger: "git-status-unknown",
        detail: `Git ignore status could not be determined safely${decision.reason ? `: ${decision.reason}` : "."}`,
      };
    }
  }
  return undefined;
}

function sensitiveTrigger(
  target: CanonicalTarget,
  boundaryRoot: string,
): { trigger: PathReviewTrigger; detail: string } | undefined {
  const classifiedPaths = [...new Set([target.lexicalPath, target.canonicalPath])];
  for (const path of classifiedPaths) {
    const pathForClassification = contains(boundaryRoot, path)
      ? relative(boundaryRoot, path)
      : path;
    const normalized = pathForClassification.replaceAll("\\", "/");
    const segments = normalized
      .split("/")
      .filter(Boolean)
      .map((segment) => segment.toLowerCase());
    const name = basename(path).toLowerCase();

    if (segments.includes(".git") || segments.includes(".jj")) {
      return {
        trigger: "vcs-metadata",
        detail: "The target is version-control metadata and direct access requires review.",
      };
    }

    const secretDirectories = new Set([
      ".ssh",
      ".aws",
      ".gnupg",
      ".kube",
      ".docker",
      "secrets",
      "credentials",
    ]);
    const dotenvExemptions = new Set([".env.example", ".env.sample", ".env.template"]);
    const exactSensitiveNames = new Set([
      ".npmrc",
      ".pypirc",
      ".netrc",
      ".git-credentials",
      "auth.json",
      "credentials",
      "credentials.json",
      "credentials.yaml",
      "credentials.yml",
      "id_rsa",
      "id_dsa",
      "id_ecdsa",
      "id_ed25519",
    ]);
    const privateKeyExtensions = [".key", ".pem", ".p12", ".pfx", ".jks"];
    const isDotenv = (name === ".env" || name.startsWith(".env.")) && !dotenvExemptions.has(name);
    if (
      segments.some((segment) => secretDirectories.has(segment)) ||
      exactSensitiveNames.has(name) ||
      privateKeyExtensions.some((extension) => name.endsWith(extension)) ||
      isDotenv
    ) {
      return {
        trigger: "sensitive-path",
        detail: "The target name or directory commonly contains secrets or credentials.",
      };
    }
  }
  return undefined;
}

function review(
  target: CanonicalTarget,
  requestedPath: string,
  trigger: PathReviewTrigger,
  detail: string,
): PathDecision {
  return {
    kind: "review",
    canonicalPath: target.canonicalPath,
    reason: detail,
    evidence: {
      canonicalPath: target.canonicalPath,
      requestedPath,
      triggers: [trigger],
      detail,
    },
  };
}

function deny(canonicalPath: string, reason: string): PathDecision {
  return { kind: "deny", canonicalPath, reason };
}

/**
 * Root of this distribution, derived from this file's own location.
 *
 * Pi-Tai may be checked out in a workspace, installed under the agent
 * directory, or pulled in as a dependency, so its path cannot be assumed. What
 * does hold is the layout inside the package: this file is always at
 * `<root>/src/core/guardian/paths.ts`.
 */
function piTaiPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export async function canonicalizeCwd(cwd: string): Promise<string> {
  return realpath(cwd);
}

async function canonicalizeTarget(cwd: string, path: string): Promise<CanonicalTarget> {
  const lexicalPath = resolve(cwd, path);
  let existing = lexicalPath;

  while (!(await pathExists(existing))) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error(`no existing parent for ${lexicalPath}`);
    existing = parent;
  }

  const canonicalExisting = await realpath(existing);
  return {
    lexicalPath,
    existingAncestor: existing,
    canonicalPath: resolve(canonicalExisting, relative(existing, lexicalPath)),
  };
}

async function canonicalRoot(candidate: string): Promise<string | undefined> {
  try {
    return await realpath(candidate);
  } catch {
    return undefined;
  }
}

async function canonicalRoots(candidates: readonly string[]): Promise<string[]> {
  const roots = await Promise.all(candidates.map(canonicalRoot));
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
  return (
    remainder === "" ||
    (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder))
  );
}

function stripAtPrefix(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
