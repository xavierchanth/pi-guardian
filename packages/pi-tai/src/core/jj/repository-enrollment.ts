import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { absolutePath } from "./domain.ts";
import {
  JjProcessExecutor,
  renderJjExecutionFailure,
  type JjAccess,
  type JjExecutor,
} from "./executor.ts";
import {
  enrollmentPlanDigest,
  enrollmentReceiptDigest,
  type RepositoryEnrollmentPlanV1,
  type RepositoryEnrollmentReceiptV1,
  type RepositoryEnrollmentV1,
  type RepositoryInitializationMode,
} from "../concurrency/productization.ts";

const PRIVATE_ALIAS_NAME = 'revset-aliases."pi_tai_private()"';
const PRIVATE_ALIAS = "pi_tai_private()" as const;
const PRIVATE_EXPRESSION = 'description(glob:"pi-tai:*")' as const;

export interface RepositoryEnrollmentStore {
  get(planOrRepositoryKey: string): Promise<RepositoryEnrollmentV1 | undefined>;
  put(key: string, value: RepositoryEnrollmentV1): Promise<void>;
}

export interface EnrollmentHostServicePort {
  request<T = unknown>(method: string, params: unknown): Promise<T>;
}

export class HostRepositoryEnrollmentStore implements RepositoryEnrollmentStore {
  private readonly host: EnrollmentHostServicePort;
  private readonly revisions = new Map<string, number>();
  constructor(host: EnrollmentHostServicePort) {
    this.host = host;
  }
  async get(key: string): Promise<RepositoryEnrollmentV1 | undefined> {
    const aggregate = await this.host.request<any>("repository.enrollment.load", { key });
    if (!aggregate) {
      this.revisions.set(key, 0);
      return undefined;
    }
    if (
      !Number.isSafeInteger(aggregate.revision) ||
      aggregate.revision < 1 ||
      !aggregate.projection
    )
      throw new Error("Host repository enrollment aggregate is invalid.");
    this.revisions.set(key, aggregate.revision);
    return aggregate.projection as RepositoryEnrollmentV1;
  }
  async put(key: string, value: RepositoryEnrollmentV1): Promise<void> {
    const expectedRevision =
      this.revisions.get(key) ?? (await this.get(key), this.revisions.get(key) ?? 0);
    const aggregate = await this.host.request<any>("repository.enrollment.put", {
      key,
      transactionId: `enrollment-transaction-${randomUUID()}`,
      expectedRevision,
      value,
    });
    if (!Number.isSafeInteger(aggregate?.revision) || aggregate.revision !== expectedRevision + 1)
      throw new Error("Host did not durably advance repository enrollment state.");
    this.revisions.set(key, aggregate.revision);
  }
}

export class FileRepositoryEnrollmentStore implements RepositoryEnrollmentStore {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  async get(key: string): Promise<RepositoryEnrollmentV1 | undefined> {
    try {
      return JSON.parse(await readFile(this.path(key), "utf8")) as RepositoryEnrollmentV1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async put(key: string, value: RepositoryEnrollmentV1): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = this.path(key);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  }
  private path(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Repository enrollment key must be SHA-256.");
    return join(this.root, `${key}.json`);
  }
}

export interface RepositoryEnrollmentAuthorization {
  readonly authorizationId: string;
  readonly planDigest: string;
  readonly authorizedAt: string;
}

export interface RepositoryEnrollmentServiceOptions {
  store: RepositoryEnrollmentStore;
  executor?: JjExecutor;
  now?: () => string;
  id?: () => string;
  failpoint?: (boundary: string) => void;
}

export class RepositoryEnrollmentService {
  private readonly store: RepositoryEnrollmentStore;
  private readonly executor: JjExecutor;
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly failpoint?: (boundary: string) => void;
  constructor(options: RepositoryEnrollmentServiceOptions) {
    this.store = options.store;
    this.executor = options.executor ?? new JjProcessExecutor();
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? randomUUID;
    this.failpoint = options.failpoint;
  }

  async plan(cwd: string): Promise<{
    key: string;
    enrollment?: RepositoryEnrollmentV1;
    plan: RepositoryEnrollmentPlanV1;
  }> {
    const start = resolve(cwd);
    if (!isAbsolute(start)) throw new Error("Repository initialization cwd must be absolute.");
    const detected = await this.detect(start);
    const repositoryPath = detected.root;
    const canonicalRepositoryPath =
      detected.mode === "existing_jj" ? await this.repositoryStorePath(repositoryPath) : undefined;
    const priorPrivateCommits =
      detected.mode === "existing_jj"
        ? (await this.optional(repositoryPath, ["config", "get", "git.private-commits"]))?.trim() ||
          "none()"
        : "description(glob:'wip:*') | description(glob:'private:*')";
    const nextPrivateCommits = containsAlias(priorPrivateCommits)
      ? priorPrivateCommits
      : `(${priorPrivateCommits}) | ${PRIVATE_ALIAS}`;
    const key = repositoryKey(canonicalRepositoryPath ?? repositoryPath);
    const base = {
      version: 1 as const,
      planId: `enrollment-plan-${this.id()}`,
      repositoryPath,
      ...(canonicalRepositoryPath ? { canonicalRepositoryPath } : {}),
      initializationMode: detected.mode,
      managedWorkspaceRoot: join(repositoryPath, ".jj", "pi-tai", "workspaces"),
      privateRevsetAlias: PRIVATE_ALIAS,
      privateRevsetExpression: PRIVATE_EXPRESSION,
      priorPrivateCommits,
      nextPrivateCommits,
    };
    const plan: RepositoryEnrollmentPlanV1 = { ...base, planDigest: enrollmentPlanDigest(base) };
    const enrollment = await this.store.get(key);
    return { key, ...(enrollment ? { enrollment } : {}), plan };
  }

  async enroll(
    plan: RepositoryEnrollmentPlanV1,
    authorization: RepositoryEnrollmentAuthorization,
  ): Promise<RepositoryEnrollmentReceiptV1> {
    if (
      authorization.planDigest !== plan.planDigest ||
      enrollmentPlanDigest(withoutPlanDigest(plan)) !== plan.planDigest
    ) {
      throw new Error("Repository enrollment authorization does not match the exact plan.");
    }
    const provisionalKey = repositoryKey(plan.canonicalRepositoryPath ?? plan.repositoryPath);
    const startedAt = this.now();
    await this.store.put(provisionalKey, {
      version: 1,
      phase: "initializing",
      plan,
      userAuthorizationId: authorization.authorizationId,
      boundary: "authorized",
      startedAt,
      evidence: { authorizedAt: authorization.authorizedAt },
    });
    this.trigger("authorized");
    try {
      if (plan.initializationMode !== "existing_jj") {
        await this.run(
          plan.repositoryPath,
          ["git", "init", "--colocate", plan.repositoryPath],
          "write",
        );
      }
      await this.boundary(
        provisionalKey,
        plan,
        authorization,
        startedAt,
        "repository_initialized",
        {},
      );
      const repositoryStore = await this.repositoryStorePath(plan.repositoryPath);
      await this.run(
        plan.repositoryPath,
        ["config", "set", "--repo", PRIVATE_ALIAS_NAME, PRIVATE_EXPRESSION],
        "write",
      );
      await this.boundary(provisionalKey, plan, authorization, startedAt, "alias_configured", {
        repositoryStore,
      });
      await this.run(
        plan.repositoryPath,
        ["config", "set", "--repo", "git.private-commits", plan.nextPrivateCommits],
        "write",
      );
      await this.boundary(
        provisionalKey,
        plan,
        authorization,
        startedAt,
        "private_commits_configured",
        { repositoryStore },
      );
      await mkdir(plan.managedWorkspaceRoot, { recursive: true, mode: 0o700 });
      await this.boundary(
        provisionalKey,
        plan,
        authorization,
        startedAt,
        "workspace_root_created",
        { repositoryStore },
      );
      const alias = (
        await this.run(plan.repositoryPath, ["config", "get", PRIVATE_ALIAS_NAME], "read")
      ).trim();
      const privateCommits = (
        await this.run(plan.repositoryPath, ["config", "get", "git.private-commits"], "read")
      ).trim();
      if (alias !== PRIVATE_EXPRESSION || !containsAlias(privateCommits))
        throw new Error("Repository private-commit configuration verification failed.");
      await this.run(
        plan.repositoryPath,
        ["log", "--revision", PRIVATE_ALIAS, "--no-graph", "--template", 'change_id ++ "\\n"'],
        "read",
      );
      await access(plan.managedWorkspaceRoot);
      const repositoryId = repositoryKey(repositoryStore);
      const configDigest = digest({ alias, privateCommits });
      const receiptBase = {
        enrollmentId: `enrollment-${this.id()}`,
        repositoryId,
        canonicalRepositoryPath: repositoryStore,
        managedWorkspaceRoot: plan.managedWorkspaceRoot,
        initializationMode: plan.initializationMode,
        planDigest: plan.planDigest,
        configDigest,
        userAuthorizationId: authorization.authorizationId,
        enrolledAt: this.now(),
      };
      const receipt: RepositoryEnrollmentReceiptV1 = {
        ...receiptBase,
        receiptDigest: enrollmentReceiptDigest(receiptBase),
      };
      const ready: RepositoryEnrollmentV1 = { version: 1, phase: "ready", receipt };
      await this.store.put(provisionalKey, ready);
      if (repositoryId !== provisionalKey) await this.store.put(repositoryId, ready);
      return receipt;
    } catch (error) {
      const current = await this.store.get(provisionalKey);
      const lastSafeBoundary = current?.phase === "initializing" ? current.boundary : "authorized";
      await this.store.put(provisionalKey, {
        version: 1,
        phase: "attention_required",
        plan,
        lastSafeBoundary,
        reason: error instanceof Error ? error.message : String(error),
        evidence: current,
        stoppedAt: this.now(),
      });
      throw error;
    }
  }

  async verify(cwd: string): Promise<RepositoryEnrollmentReceiptV1> {
    const repositoryStore = await this.repositoryStorePath(resolve(cwd));
    const key = repositoryKey(repositoryStore);
    const enrollment = await this.store.get(key);
    if (!enrollment || enrollment.phase !== "ready")
      throw new Error("Repository is not enrolled with Pi-Tai. Run /init-pi-tai.");
    if (enrollment.receipt.canonicalRepositoryPath !== repositoryStore)
      throw new Error("Repository enrollment identity changed.");
    const alias = (await this.optional(cwd, ["config", "get", PRIVATE_ALIAS_NAME]))?.trim();
    const privateCommits = (
      await this.optional(cwd, ["config", "get", "git.private-commits"])
    )?.trim();
    if (alias !== PRIVATE_EXPRESSION || !privateCommits || !containsAlias(privateCommits)) {
      const drifted: RepositoryEnrollmentV1 = {
        version: 1,
        phase: "repair_required",
        receipt: enrollment.receipt,
        reason: "Repo-local Pi-Tai private-commit configuration drifted.",
        observedAt: this.now(),
      };
      await this.store.put(key, drifted);
      throw new Error(
        "Repository enrollment configuration drifted. Re-run /init-pi-tai to review repairs.",
      );
    }
    if (digest({ alias, privateCommits }) !== enrollment.receipt.configDigest) {
      const drifted: RepositoryEnrollmentV1 = {
        version: 1,
        phase: "repair_required",
        receipt: enrollment.receipt,
        reason: "Repo-local private-commit expression changed after enrollment.",
        observedAt: this.now(),
      };
      await this.store.put(key, drifted);
      throw new Error(
        "Repository enrollment configuration changed. Re-run /init-pi-tai to review repairs.",
      );
    }
    await access(enrollment.receipt.managedWorkspaceRoot);
    return enrollment.receipt;
  }

  private async boundary(
    key: string,
    plan: RepositoryEnrollmentPlanV1,
    authorization: RepositoryEnrollmentAuthorization,
    startedAt: string,
    boundary: Extract<RepositoryEnrollmentV1, { phase: "initializing" }>["boundary"],
    evidence: unknown,
  ): Promise<void> {
    await this.store.put(key, {
      version: 1,
      phase: "initializing",
      plan,
      userAuthorizationId: authorization.authorizationId,
      boundary,
      startedAt,
      evidence,
    });
    this.trigger(boundary);
  }
  private trigger(boundary: string): void {
    this.failpoint?.(boundary);
  }
  private async detect(
    start: string,
  ): Promise<{ root: string; mode: RepositoryInitializationMode }> {
    const jjRoot = await this.optional(start, ["root"]);
    if (jjRoot?.trim()) return { root: resolve(jjRoot.trim()), mode: "existing_jj" };
    const gitRoot = await nearestMarker(start, ".git");
    return gitRoot
      ? { root: gitRoot, mode: "colocate_git" }
      : { root: start, mode: "new_colocated" };
  }
  private async repositoryStorePath(cwd: string): Promise<string> {
    const root = (await this.run(cwd, ["root"], "read")).trim();
    if (!root || root.includes("\n")) throw new Error("Unable to resolve one JJ repository root.");
    const { realpath } = await import("node:fs/promises");
    return realpath(join(root, ".jj", "repo"));
  }
  private optional(cwd: string, args: readonly string[]): Promise<string | undefined> {
    return this.executor
      .execute({ cwd: absolutePath(resolve(cwd)), args, access: "read" })
      .then((result) => (result.kind === "success" ? result.stdout : undefined));
  }
  private async run(cwd: string, args: readonly string[], accessMode: JjAccess): Promise<string> {
    const result = await this.executor.execute({
      cwd: absolutePath(resolve(cwd)),
      args,
      access: accessMode,
    });
    if (result.kind === "success") return result.stdout;
    throw new Error(
      `jj argv ${JSON.stringify(args)} failed: ${result.stderr.trim() || renderJjExecutionFailure(result.failure)}`,
    );
  }
}

async function nearestMarker(start: string, marker: string): Promise<string | undefined> {
  let current = resolve(start);
  while (true) {
    try {
      await access(join(current, marker));
      return current;
    } catch {
      /* continue */
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
function containsAlias(expression: string): boolean {
  return /\bpi_tai_private\s*\(\s*\)/.test(expression);
}
function repositoryKey(path: string): string {
  return digest(resolve(path));
}
function digest(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}
function withoutPlanDigest(
  plan: RepositoryEnrollmentPlanV1,
): Omit<RepositoryEnrollmentPlanV1, "planDigest"> {
  const { planDigest: _, ...rest } = plan;
  return rest;
}
