import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  checkFileToolPath,
  defaultReadCandidates,
} from "../../packages/pi-tai/src/guardian/paths.ts";
import {
  REVIEWER_SYSTEM_PROMPT,
  buildReviewPrompt,
  parseReviewDecision,
  preflightManagedSubagentCleanup,
} from "../../packages/pi-tai/src/guardian/policy.ts";
import { registerApprovalGuardian } from "../../packages/pi-tai/src/guardian/register.ts";
import { createGuardianReviewRecorder } from "../../packages/pi-tai/src/guardian/records.ts";
import {
  createModelReviewer,
  REVIEW_TIMEOUT_MS,
  resolveReviewerModel,
  type ReviewRequest,
  type ReviewResult,
} from "../../packages/pi-tai/src/guardian/reviewer.ts";
import type { WorkContextSnapshot } from "../../packages/pi-tai/src/work-context/domain.ts";

const execFileAsync = promisify(execFile);

test("managed subagent runtime cleanup bypasses review under a custom store root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-guardian-cleanup-"));
  const stateRoot = join(root, "state");
  const storeRoot = join(stateRoot, "delegations");
  for (const directory of ["delegations", "logs", "control", "prompts"]) {
    await mkdir(join(stateRoot, directory), { recursive: true });
  }
  const paths = [
    join(stateRoot, "logs", "child_1.jsonl"),
    join(stateRoot, "logs", "child_1.stderr.log"),
    join(stateRoot, "control", "child_1.fifo"),
    join(stateRoot, "prompts", "child_1.md"),
  ];
  for (const path of paths) await writeFile(path, "runtime");
  await writeFile(join(storeRoot, "child_1.json"), JSON.stringify({ id: "child_1" }));

  assert.deepEqual(await preflightManagedSubagentCleanup(
    { command: `rm -f -- ${paths.map((path) => `'${path}'`).join(" ")}` },
    root,
    storeRoot,
  ), { kind: "allow" });
  assert.deepEqual(await preflightManagedSubagentCleanup(
    { command: `unlink '${paths[0]}'` },
    root,
    storeRoot,
  ), { kind: "allow" });

  let reviews = 0;
  let handler: (event: unknown, ctx: unknown) => Promise<unknown> = async () => undefined;
  const pi = {
    on(_name: string, received: typeof handler) { handler = received; },
    events: { emit() {} },
    getAllTools: () => [],
  } as unknown as ExtensionAPI;
  registerApprovalGuardian(pi, {
    delegationStoreRoot: storeRoot,
    reviewer: async () => { reviews++; return allow(); },
  });
  assert.equal(await handler(bashEvent(`rm -f '${paths[0]}'`), fakeContext()), undefined);
  assert.equal(reviews, 0);
});

test("managed subagent state deletion outside exact artifacts requires model review", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-guardian-cleanup-deny-"));
  const stateRoot = join(root, "state");
  const storeRoot = join(stateRoot, "delegations");
  await mkdir(join(stateRoot, "logs"), { recursive: true });
  await mkdir(storeRoot);
  await writeFile(join(storeRoot, "child.json"), "{}");
  await symlink(join(storeRoot, "child.json"), join(stateRoot, "logs", "child.jsonl"));

  for (const command of [
    `rm -f '${join(storeRoot, "child.json")}'`,
    `rm -rf '${stateRoot}'`,
    `rm -f '${join(stateRoot, "logs", "other.txt")}'`,
    `rm -f '${join(stateRoot, "logs", "child.jsonl")}'`,
  ]) {
    const decision = await preflightManagedSubagentCleanup({ command }, root, storeRoot);
    assert.equal(decision.kind, "deny", command);
  }
  assert.equal((await preflightManagedSubagentCleanup({ command: "pwd" }, root, storeRoot)).kind, "review");

  let reviewed = false;
  let handler: (event: unknown, ctx: unknown) => Promise<unknown> = async () => undefined;
  const pi = {
    on(_name: string, received: typeof handler) { handler = received; },
    events: { emit() {} },
    getAllTools: () => [],
  } as unknown as ExtensionAPI;
  registerApprovalGuardian(pi, {
    delegationStoreRoot: storeRoot,
    reviewer: async () => { reviewed = true; return allow(); },
  });
  assert.equal(await handler(bashEvent(`rm -rf '${stateRoot}'`), fakeContext()), undefined);
  assert.equal(reviewed, true);
});

test("ordinary agent bash calls get fresh reviews", async () => {
  const requests: ReviewRequest[] = [];
  const { handler } = registerWith(async (request) => {
    requests.push(request);
    return allow();
  });
  const ctx = fakeContext();

  await handler(bashEvent("pwd"), ctx);
  await handler(bashEvent("rg --files"), ctx);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].action.arguments.command, "pwd");
  assert.equal(requests[1].action.arguments.command, "rg --files");
  assert.notEqual(requests[0].action, requests[1].action);
});

test("inside-boundary unignored built-in file tools bypass model review", async () => {
  let reviews = 0;
  const { handler } = registerWith(async () => {
    reviews++;
    return allow();
  });

  const result = await handler(toolEvent("read", { path: "package.json" }), fakeContext());
  assert.equal(result, undefined);
  assert.equal(reviews, 0);
});

test("ignored built-in file targets receive Guardian review with path evidence", async () => {
  const requests: ReviewRequest[] = [];
  const { handler } = registerWith(async (request) => {
    requests.push(request);
    return allow();
  });

  const result = await handler(
    toolEvent("read", { path: "node_modules/typescript/package.json" }),
    fakeContext(),
  );
  assert.equal(result, undefined);
  assert.equal(requests.length, 1);
  assert.deepEqual(
    (requests[0].reviewEvidence as { triggers: string[] }).triggers,
    ["gitignored"],
  );
});

test("outside, traversal, and symlink-escape file targets are denied", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-guardian-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await symlink(outside, join(workspace, "escape"));

  const traversal = await checkFileToolPath("read", { path: "../outside" }, workspace, [], []);
  const escaped = await checkFileToolPath("write", { path: "escape/new.txt" }, workspace, [], []);
  const inside = await checkFileToolPath("edit", { path: "new.txt" }, workspace, [], []);

  assert.equal(traversal.kind, "deny");
  assert.equal(escaped.kind, "deny");
  assert.equal(inside.kind, "allow");
});

test("Git-ignored and secret-like direct targets review while aggregate searches stay automatic", async () => {
  const { workspace, agentDir } = await gitFixture();
  await mkdir(join(workspace, "ignored"));
  await writeFile(join(workspace, "ignored", "data.txt"), "private");
  await mkdir(join(workspace, "nested"));
  await writeFile(join(workspace, "nested", ".gitignore"), "*.secret\n");
  await writeFile(join(workspace, "nested", "token.secret"), "private");
  await writeFile(join(workspace, ".env.example"), "TOKEN=example\n");
  await symlink(".env.example", join(workspace, ".env.local"));
  await writeFile(join(workspace, "credentials.json"), "{}\n");

  for (const path of ["ignored/data.txt", "nested/token.secret", "future.log"]) {
    const decision = await checkFileToolPath("read", { path }, workspace, [], [], agentDir);
    assert.equal(decision.kind, "review", path);
    assert.equal(decision.evidence?.triggers[0], "gitignored", path);
  }

  const futureWrite = await checkFileToolPath(
    "write",
    { path: "future.log" },
    workspace,
    [],
    [],
    agentDir,
  );
  assert.equal(futureWrite.kind, "review");

  const credentials = await checkFileToolPath(
    "read",
    { path: "credentials.json" },
    workspace,
    [],
    [],
    agentDir,
  );
  assert.equal(credentials.kind, "review");
  assert.equal(credentials.evidence?.triggers[0], "sensitive-path");

  const dotenvExample = await checkFileToolPath(
    "read",
    { path: ".env.example" },
    workspace,
    [],
    [],
    agentDir,
  );
  assert.equal(dotenvExample.kind, "allow");
  const dotenvSymlink = await checkFileToolPath(
    "read",
    { path: ".env.local" },
    workspace,
    [],
    [],
    agentDir,
  );
  assert.equal(dotenvSymlink.kind, "review");
  assert.equal(dotenvSymlink.evidence?.triggers[0], "sensitive-path");

  for (const toolName of ["grep", "find"]) {
    const aggregate = await checkFileToolPath(
      toolName,
      { path: "." },
      workspace,
      [],
      [],
      agentDir,
    );
    assert.equal(aggregate.kind, "allow", toolName);
  }

  const metadata = await checkFileToolPath(
    "read",
    { path: ".git/config" },
    workspace,
    [],
    [],
    agentDir,
  );
  assert.equal(metadata.kind, "review");
  assert.equal(metadata.evidence?.triggers[0], "vcs-metadata");
});

test("Pi credentials and sessions review, safe state reads automatically, and writes deny", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-guardian-agent-state-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  for (const file of ["models.json", "settings.json", "trust.json", "models-store.json", "safe.json"]) {
    await writeFile(join(agentDir, file), "{}\n");
  }
  await symlink("safe.json", join(agentDir, "auth.json"));
  await symlink(outside, join(agentDir, "escape"));
  await writeFile(join(agentDir, "sessions", "conversation.jsonl"), "{}\n");

  for (const path of ["auth.json", "models.json", "sessions/conversation.jsonl"]) {
    const decision = await checkFileToolPath(
      "read",
      { path: join(agentDir, path) },
      workspace,
      [],
      [],
      agentDir,
    );
    assert.equal(decision.kind, "review", path);
  }

  for (const file of ["settings.json", "trust.json", "models-store.json"]) {
    const decision = await checkFileToolPath(
      "read",
      { path: join(agentDir, file) },
      workspace,
      [],
      [],
      agentDir,
    );
    assert.equal(decision.kind, "allow", file);
  }

  assert.equal((await checkFileToolPath(
    "find",
    { path: agentDir },
    workspace,
    [],
    [],
    agentDir,
  )).kind, "review");
  assert.equal((await checkFileToolPath(
    "ls",
    { path: agentDir },
    workspace,
    [],
    [],
    agentDir,
  )).kind, "allow");
  assert.equal((await checkFileToolPath(
    "write",
    { path: join(agentDir, "settings.json") },
    workspace,
    [],
    [],
    agentDir,
  )).kind, "deny");
  assert.equal((await checkFileToolPath(
    "read",
    { path: join(agentDir, "escape", "new.txt") },
    workspace,
    [],
    [],
    agentDir,
  )).kind, "deny");
});

test("default read roots include safe Pi state but exclude credentials and sessions", () => {
  const candidates = defaultReadCandidates();
  assert.ok(candidates.some((path) => path.endsWith("/.agents/skills")));
  assert.ok(candidates.some((path) => path.endsWith("/.pi/agent/extensions")));
  assert.ok(candidates.some((path) => path.endsWith("/.pi/agent/settings.json")));
  assert.ok(candidates.some((path) => path.endsWith("/@earendil-works/pi-coding-agent")));
  assert.equal(candidates.some((path) => path.endsWith("/.pi/agent/auth.json")), false);
  assert.equal(candidates.some((path) => path.endsWith("/.pi/agent/sessions")), false);
});

test("read-only tools may inspect configured skill and Pi roots without allowing writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-guardian-read-roots-"));
  const workspace = join(root, "workspace");
  const skills = join(root, "skills");
  const linkedSkills = join(root, "linked-skills");
  const nonexistentAgent = join(root, "agent");
  await mkdir(workspace);
  await mkdir(skills);
  await symlink(skills, linkedSkills);

  for (const toolName of ["read", "grep", "find", "ls"]) {
    const decision = await checkFileToolPath(
      toolName,
      { path: join(linkedSkills, "jj-guidelines", "SKILL.md") },
      workspace,
      [],
      [linkedSkills],
      nonexistentAgent,
    );
    assert.equal(decision.kind, "allow", toolName);
  }

  for (const toolName of ["write", "edit"]) {
    const decision = await checkFileToolPath(
      toolName,
      { path: join(linkedSkills, "new.md") },
      workspace,
      [],
      [linkedSkills],
      nonexistentAgent,
    );
    assert.equal(decision.kind, "deny", toolName);
  }
});

test("review prompt preserves roles, action, evidence, work context, and autonomy doctrine", () => {
  const action = {
    toolName: "bash",
    arguments: { command: "rg token src" },
    cwd: "/workspace",
  };
  const workContext: WorkContextSnapshot = {
    goal: "Inspect the repository",
    explanation: "Confirm the exact target",
    plan: [{ content: "Search source", status: "in_progress" }],
  };
  const prompt = buildReviewPrompt([
    { role: "user", content: "Inspect the implementation." },
    { role: "assistant", content: "I will inspect it." },
    { role: "toolResult", content: "previous failure" },
  ], action, workContext, { triggers: ["gitignored"] });

  assert.match(prompt, /role="user"/);
  assert.match(prompt, /Inspect the implementation/);
  assert.match(prompt, /role="assistant"/);
  assert.match(prompt, /previous failure/);
  assert.match(prompt, /<work_context>/);
  assert.match(prompt, /Inspect the repository/);
  assert.match(prompt, /<review_evidence>/);
  assert.match(prompt, /gitignored/);
  assert.match(prompt, /"command":"rg token src"/);
  assert.match(REVIEWER_SYSTEM_PROMPT, /Do not choose the outcome/);
  assert.match(REVIEWER_SYSTEM_PROMPT, /supporting work broadly/);
  assert.match(REVIEWER_SYSTEM_PROMPT, /Reading private data, credentials, environment variables/);
  assert.match(REVIEWER_SYSTEM_PROMPT, /development SaaS backend/);
  assert.match(REVIEWER_SYSTEM_PROMPT, /linting, tests, builds, benchmarks/);
  assert.match(REVIEWER_SYSTEM_PROMPT, /Authenticated development deployments, remote checks/);
});

test("every bash review receives the latest structured work context explicitly", async () => {
  const snapshot: WorkContextSnapshot = {
    goal: "Ship Guardian",
    plan: [
      { content: "Implement review", status: "completed" },
      { content: "Verify behavior", status: "in_progress", priority: "high" },
    ],
  };
  let request: ReviewRequest | undefined;
  const { handler } = registerWith(async (received) => {
    request = received;
    return allow();
  }, () => snapshot);

  await handler(bashEvent("npm test"), fakeContext());
  assert.deepEqual(request?.workContext, snapshot);
});

test("strict parser allows ordinary work and makes every related high-risk action human-only", () => {
  assert.deepEqual(parseReviewDecision(JSON.stringify({
    risk_level: "low", task_relationship: "supporting", impact_scope: "bounded", harm_kinds: [], reason: "routine inspection",
  })), {
    riskLevel: "low",
    taskRelationship: "supporting",
    impactScope: "bounded",
    harmKinds: [],
    outcome: "allow",
    reason: "routine inspection",
  });

  for (const [risk_level, task_relationship, outcome] of [
    ["medium", "unrelated", "allow"],
    ["high", "explicit", "human_execution_required"],
    ["high", "direct", "human_execution_required"],
    ["high", "supporting", "human_execution_required"],
    ["high", "unrelated", "deny"],
    ["high", "unclear", "deny"],
    ["critical", "explicit", "human_execution_required"],
    ["critical", "unrelated", "deny"],
  ] as const) {
    assert.equal(parseReviewDecision(JSON.stringify({
      risk_level, task_relationship, impact_scope: "bounded", harm_kinds: risk_level === "medium" ? [] : ["destructive"], reason: "matrix case",
    })).outcome, outcome);
  }

  assert.throws(() => parseReviewDecision("```json\n{}\n```"));
  assert.throws(() => parseReviewDecision(JSON.stringify({
    risk_level: "low", task_relationship: "supporting", impact_scope: "bounded", harm_kinds: [], outcome: "deny", reason: "model chose outcome",
  })));
  assert.throws(() => parseReviewDecision(JSON.stringify({
    risk_level: "low", task_relationship: "implicit", impact_scope: "bounded", harm_kinds: [], reason: "invalid relationship",
  })));
  assert.throws(() => parseReviewDecision(JSON.stringify({
    risk_level: "low", task_relationship: "supporting", impact_scope: "bounded", harm_kinds: ["unknown"], reason: "invalid harm",
  })));
});

test("clear denial returns a failed tool result without interrupting the user", async () => {
  const denied = async (): Promise<ReviewResult> => decision(
    "high",
    "unrelated",
    "deny",
    "unrelated command would destroy substantial data",
  );
  const { handler } = registerWith(denied);
  const tui = fakeContext("tui", "Execute exact action once");
  const blocked = await handler(bashEvent("credential probe"), tui);
  assert.deepEqual(blocked, {
    block: true,
    reason: "Guardian denied an unrelated or unclear high-risk action: unrelated command would destroy substantial data. The action was not executed. Do not retry, delegate, or provide a runnable command; continue with safe task work.",
  });
  assert.equal(tui.selections.length, 0);
});

test("non-allow reviews are blocked without confirmation and retained for evaluation", async () => {
  const denied = async (): Promise<ReviewResult> => decision(
    "high",
    "unrelated",
    "deny",
    "highly destructive command is unrelated to the task",
  );
  const registered = registerWith(denied);
  const tui = fakeContext("tui", "Execute exact action once");
  const blocked = await registered.handler(bashEvent("deploy candidate"), tui);
  assert.deepEqual(blocked, {
    block: true,
    reason: "Guardian denied an unrelated or unclear high-risk action: highly destructive command is unrelated to the task. The action was not executed. Do not retry, delegate, or provide a runnable command; continue with safe task work.",
  });
  assert.equal(tui.selections.length, 0);
  assert.equal(registered.recorded.length, 1);
  assert.equal(registered.recorded[0].result.kind, "decision");
  assert.deepEqual(registered.emitted, []);
});

test("local Guardian evaluation records preserve the denied action and bounded reviewer input", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-guardian-records-"));
  const recorder = createGuardianReviewRecorder(root);
  await recorder({
    result: decision("high", "unrelated", "deny", "insufficient task relationship"),
    action: { toolName: "bash", arguments: { command: "deploy" }, cwd: "/workspace" },
    messages: [{ role: "user", content: "Inspect only." }],
    mode: "print",
    sessionId: "session-id",
  });
  const monthDirectories = await readdir(root);
  assert.equal(monthDirectories.length, 1);
  const files = await readdir(join(root, monthDirectories[0]));
  assert.equal(files.length, 1);
  const record = JSON.parse(await readFile(join(root, monthDirectories[0], files[0]), "utf8"));
  assert.equal(record.category, "denied");
  assert.equal(record.action.arguments.command, "deploy");
  assert.match(record.reviewerInput, /Inspect only/);
});

test("related high-risk actions are blocked and surfaced for direct human execution", async () => {
  const registered = registerWith(async () => decision(
    "high", "supporting", "human_execution_required", "would delete production data", ["destructive", "production"],
  ));
  const blocked = await registered.handler(bashEvent("prodctl delete database"), fakeContext()) as { block: boolean; reason: string };
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /will not execute/);
  assert.match(blocked.reason, /Do not retry it, delegate it/);
  assert.match(blocked.reason, /prodctl delete database/);
  assert.equal(registered.notices.length, 1);
  assert.equal(registered.notices[0].reviewUnavailable, false);
});

test("review failure, timeout, and cancellation allow ordinary actions but stop destructive candidates", async () => {
  for (const result of [
    { kind: "timeout", reason: "timed out" },
    { kind: "failure", reason: "provider failed" },
  ] as const) {
    const { handler, emitted, recorded } = registerWith(async () => result);
    const ctx = fakeContext("tui", "Execute exact action once");
    assert.equal(await handler(bashEvent("true"), ctx), undefined);
    assert.equal(ctx.selections.length, 0);
    assert.equal(recorded.length, 1);
    assert.deepEqual(emitted, [{
      name: "pi-tai:guardian-review-failed",
      data: {
        kind: result.kind,
        mode: "tui",
        toolName: "bash",
        reason: result.reason,
        cwd: process.cwd(),
      },
    }]);
  }

  const cancelledRegistration = registerWith(async () => ({ kind: "cancelled", reason: "cancelled" }));
  const ctx = fakeContext("tui", "Execute exact action once");
  assert.equal(await cancelledRegistration.handler(bashEvent("true"), ctx), undefined);
  assert.equal(ctx.selections.length, 0);

  const unavailable = registerWith(async () => ({ kind: "failure", reason: "provider unavailable" }));
  const blocked = await unavailable.handler(bashEvent("rm -rf -- /important"), fakeContext()) as { block: boolean; reason: string };
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /could not complete review/);
  assert.equal(unavailable.notices[0].reviewUnavailable, true);
});

test("unknown tools and direct user shell remain outside extension scope", () => {
  const handlers: string[] = [];
  const pi = {
    on(name: string) {
      handlers.push(name);
    },
  } as unknown as ExtensionAPI;
  registerApprovalGuardian(pi, { reviewer: async () => allow() });
  assert.deepEqual(handlers, ["tool_call"]);
});

test("custom tools that reuse file-tool names own their own policy", async () => {
  let handler: (event: unknown, ctx: unknown) => Promise<unknown> = async () => undefined;
  const pi = {
    on(_name: string, received: typeof handler) { handler = received; },
    getAllTools: () => [{
      name: "read",
      sourceInfo: { source: "custom-extension" },
    }],
  } as unknown as ExtensionAPI;
  registerApprovalGuardian(pi, { reviewer: async () => allow() });
  assert.equal(
    await handler(toolEvent("read", { path: "/outside" }), fakeContext()),
    undefined,
  );
});

test("web_fetch is reviewed with canonical public-network evidence", async () => {
  let request: ReviewRequest | undefined;
  const state = registerWith(async (received) => {
    request = received;
    return allow();
  });
  assert.equal(
    await state.handler(
      toolEvent("web_fetch", { url: "https://Example.com/docs?q=1" }),
      fakeContext(),
    ),
    undefined,
  );
  assert.equal(request?.action.toolName, "web_fetch");
  assert.deepEqual(request?.reviewEvidence, {
    type: "web-fetch",
    requestedUrl: "https://Example.com/docs?q=1",
    canonicalUrl: "https://example.com/docs?q=1",
    hostname: "example.com",
    method: "GET",
    sendsCredentials: false,
  });
});

test("web_fetch private targets are blocked before review", async () => {
  let reviewed = false;
  const state = registerWith(async () => {
    reviewed = true;
    return allow();
  });
  const result = await state.handler(
    toolEvent("web_fetch", { url: "http://169.254.169.254/latest/meta-data" }),
    fakeContext(),
  ) as { block?: boolean; reason?: string };
  assert.equal(result.block, true);
  assert.match(result.reason ?? "", /non-public/);
  assert.equal(reviewed, false);
});

test("hosted web_search remains outside Guardian review", async () => {
  let reviewed = false;
  const state = registerWith(async () => {
    reviewed = true;
    return allow();
  });
  assert.equal(
    await state.handler(toolEvent("web_search", { query: "current docs" }), fakeContext()),
    undefined,
  );
  assert.equal(reviewed, false);
});

test("reviewer resolves the internal identity from gpt-5.4 metadata", () => {
  const template = { provider: "openai-codex", id: "gpt-5.4-mini", name: "mini" };
  const registry = {
    find(provider: string, id: string) {
      return provider === "openai-codex" && id === "gpt-5.4-mini" ? template : undefined;
    },
  } as unknown as ExtensionContext["modelRegistry"];
  const model = resolveReviewerModel(registry);
  assert.equal(model?.id, "codex-auto-review");
  assert.equal(model?.name, "Codex Auto Review");
});

test("reviewer default deadline is 30 seconds", () => {
  assert.equal(REVIEW_TIMEOUT_MS, 30_000);
});

test("reviewer session is isolated, tool-free, low-thinking, and strict", async () => {
  let resourceOptions: Record<string, unknown> | undefined;
  let sessionOptions: Record<string, unknown> | undefined;
  const output = JSON.stringify({
    risk_level: "low",
    task_relationship: "supporting",
    impact_scope: "bounded",
    harm_kinds: [],
    reason: "routine task work",
  });
  const reviewer = createModelReviewer({
    createResourceLoader(options) {
      resourceOptions = options as unknown as Record<string, unknown>;
      return { reload: async () => undefined } as never;
    },
    createSession: async (options) => {
      sessionOptions = options as unknown as Record<string, unknown>;
      return { session: fakeReviewerSession(output) } as never;
    },
  });

  const result = await reviewer(reviewRequest());
  assert.deepEqual(result, allow());
  for (const key of [
    "noExtensions", "noSkills", "noPromptTemplates", "noThemes", "noContextFiles",
  ]) assert.equal(resourceOptions?.[key], true, key);
  assert.equal(sessionOptions?.noTools, "all");
  assert.deepEqual(sessionOptions?.tools, []);
  assert.deepEqual(sessionOptions?.customTools, []);
  assert.equal(sessionOptions?.thinkingLevel, "low");
});

test("packaged skills and Pi's own files are read without Guardian review", async () => {
  const cwd = process.cwd();
  // These live under node_modules, which git ignores by construction. Ignore
  // status says nothing about reference material the agent is meant to read.
  for (const target of [
    "node_modules/@earendil-works/pi-coding-agent/README.md",
    "node_modules/@earendil-works/pi-coding-agent/docs",
    "packages/pi-tai/skills/dpic/SKILL.md",
  ]) {
    const decision = await checkFileToolPath("read", { path: target }, cwd);
    assert.equal(decision.kind, "allow", `${target} should not require review`);
  }
});

test("a credential file inside a read-only root still requires review", async () => {
  const decision = await checkFileToolPath(
    "read",
    { path: "node_modules/@earendil-works/pi-coding-agent/.npmrc" },
    process.cwd(),
  );

  assert.equal(decision.kind, "review");
  assert.equal(decision.evidence?.triggers[0], "sensitive-path");
});

test("the read-only exception does not extend to unrelated ignored files", async () => {
  const decision = await checkFileToolPath(
    "read",
    { path: "node_modules/typescript/package.json" },
    process.cwd(),
  );

  assert.equal(decision.kind, "review", "only designated Pi and skill roots are excepted");
});

test("built-in file tools still cannot write into a read-only root", async () => {
  const decision = await checkFileToolPath(
    "write",
    { path: "node_modules/@earendil-works/pi-coding-agent/README.md" },
    process.cwd(),
  );

  assert.notEqual(decision.kind, "allow");
});

test("pi-tai's own resources are readable from an unrelated working directory", async () => {
  // Pi-Tai may be checked out, installed under the agent directory, or pulled in
  // as a dependency, so its location cannot be assumed from the workspace.
  const [piTaiRoot] = defaultReadCandidates();
  assert.ok(piTaiRoot.endsWith(join("packages", "pi-tai")), `unexpected root: ${piTaiRoot}`);

  for (const relativePath of ["skills/dpic/SKILL.md", "prompts/dpic.md", "instructions/system.md"]) {
    const decision = await checkFileToolPath("read", { path: join(piTaiRoot, relativePath) }, tmpdir());
    assert.equal(decision.kind, "allow", `${relativePath} should be readable from any cwd`);
  }
});

test("reviewer reports malformed output, timeout, cancellation, and provider failure", async () => {
  const invalid = createModelReviewer(fakeReviewerDependencies("not json"));
  assert.equal((await invalid(reviewRequest())).kind, "failure");

  const failure = createModelReviewer({
    createResourceLoader: () => ({ reload: async () => undefined }) as never,
    createSession: async () => { throw new Error("provider unavailable"); },
  });
  const providerResult = await failure(reviewRequest());
  assert.equal(providerResult.kind, "failure");
  if (providerResult.kind === "failure") {
    assert.match(providerResult.reason, /provider unavailable/);
  }

  const timeout = createModelReviewer({
    createResourceLoader: () => ({ reload: async () => undefined }) as never,
    createSession: () => new Promise(() => undefined),
  });
  assert.equal((await timeout(reviewRequest({ timeoutMs: 5 }))).kind, "timeout");

  const controller = new AbortController();
  controller.abort();
  const cancelled = createModelReviewer(fakeReviewerDependencies(JSON.stringify({
    risk_level: "low",
    task_relationship: "supporting",
    impact_scope: "bounded",
    harm_kinds: [],
    reason: "ok",
  })));
  assert.equal((await cancelled(reviewRequest({ signal: controller.signal }))).kind, "cancelled");
});

async function gitFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-guardian-git-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent-does-not-exist");
  await mkdir(workspace);
  await execFileAsync("git", ["init", "-q", workspace]);
  await writeFile(join(workspace, ".gitignore"), "ignored/\nfuture.log\n");
  return { workspace, agentDir };
}

function registerWith(
  reviewer: (request: ReviewRequest) => Promise<ReviewResult>,
  workContext?: () => WorkContextSnapshot | undefined,
) {
  let handler: (event: never, ctx: never) => Promise<unknown> = async () => undefined;
  const emitted: Array<{ name: string; data: unknown }> = [];
  const recorded: any[] = [];
  const notices: any[] = [];
  const pi = {
    on(name: string, received: typeof handler) {
      assert.equal(name, "tool_call");
      handler = received;
    },
    events: {
      emit(name: string, data: unknown) {
        emitted.push({ name, data });
      },
    },
    getAllTools: () => [...["read", "write", "edit", "grep", "find", "ls"].map((name) => ({
      name,
      sourceInfo: { source: "builtin" },
    }))],
  } as unknown as ExtensionAPI;
  registerApprovalGuardian(pi, {
    reviewer,
    workContext,
    recorder: async (input) => { recorded.push(input); },
    onHumanExecutionRequired: async (notice) => { notices.push(notice); },
  });
  return { handler: handler as (event: unknown, ctx: unknown) => Promise<unknown>, emitted, recorded, notices };
}

function fakeContext(mode: "tui" | "print" = "print", choice?: string) {
  const selections: Array<{ title: string; options: string[] }> = [];
  return {
    cwd: process.cwd(),
    mode,
    modelRegistry: fakeRegistry(),
    sessionManager: {
      buildContextEntries: () => [],
      getSessionId: () => "session-id",
      getSessionFile: () => "/session.jsonl",
    },
    signal: undefined,
    selections,
    ui: {
      async select(title: string, options: string[]) {
        selections.push({ title, options });
        return choice;
      },
    },
  };
}

function fakeRegistry() {
  const model = {
    provider: "openai-codex",
    id: "codex-auto-review",
    name: "Codex Auto Review",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 10_000,
  };
  return {
    runtime: {},
    find(provider: string, id: string) {
      return provider === model.provider && id === model.id ? model : undefined;
    },
  } as unknown as ExtensionContext["modelRegistry"];
}

function reviewRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    modelRegistry: fakeRegistry(),
    cwd: process.cwd(),
    messages: [{ role: "user", content: "Inspect the repository." }],
    action: { toolName: "bash", arguments: { command: "true" }, cwd: process.cwd() },
    ...overrides,
  };
}

function fakeReviewerDependencies(output: string) {
  return {
    createResourceLoader: () => ({ reload: async () => undefined }) as never,
    createSession: async () => ({ session: fakeReviewerSession(output) }) as never,
  };
}

function fakeReviewerSession(output: string) {
  return {
    messages: [{
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: output }],
    }],
    isStreaming: false,
    prompt: async () => undefined,
    abort: async () => undefined,
    dispose: () => undefined,
  } as never;
}

function decision(
  riskLevel: "low" | "medium" | "high" | "critical",
  taskRelationship: "explicit" | "direct" | "supporting" | "unrelated" | "unclear",
  outcome: "allow" | "human_execution_required" | "deny",
  reason: string,
  harmKinds: Array<"destructive" | "production" | "sensitive_egress" | "financial" | "privilege" | "privacy"> = [],
): ReviewResult {
  return {
    kind: "decision",
    decision: { riskLevel, taskRelationship, impactScope: "bounded", harmKinds, outcome, reason },
  };
}

function allow(): ReviewResult {
  return decision("low", "supporting", "allow", "routine task work");
}

function bashEvent(command: string) {
  return toolEvent("bash", { command });
}

function toolEvent(toolName: string, input: Record<string, unknown>) {
  return { toolName, toolCallId: "call", input };
}
