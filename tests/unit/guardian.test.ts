import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkFileToolPath } from "../../packages/pi-tai/src/guardian/paths.ts";
import {
  REVIEWER_SYSTEM_PROMPT,
  buildReviewPrompt,
  parseReviewDecision,
} from "../../packages/pi-tai/src/guardian/policy.ts";
import { registerApprovalGuardian } from "../../packages/pi-tai/src/guardian/register.ts";
import {
  createModelReviewer,
  REVIEW_TIMEOUT_MS,
  resolveReviewerModel,
  type ReviewRequest,
  type ReviewResult,
} from "../../packages/pi-tai/src/guardian/reviewer.ts";
import type { WorkContextSnapshot } from "../../packages/pi-tai/src/work-context/domain.ts";

test("every agent bash call gets a fresh review without command exceptions", async () => {
  const { handler } = registerWith(async (request) => {
    requests.push(request);
    return allow();
  });
  const requests: ReviewRequest[] = [];
  const ctx = fakeContext();

  await handler(bashEvent("pwd"), ctx);
  await handler(bashEvent("rg --files"), ctx);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].action.arguments.command, "pwd");
  assert.equal(requests[1].action.arguments.command, "rg --files");
  assert.notEqual(requests[0].action, requests[1].action);
});

test("inside-boundary built-in file tools bypass model review", async () => {
  let reviews = 0;
  const { handler } = registerWith(async () => {
    reviews++;
    return allow();
  });

  const result = await handler(toolEvent("read", { path: "package.json" }), fakeContext());
  assert.equal(result, undefined);
  assert.equal(reviews, 0);
});

test("outside, traversal, and symlink-escape file targets are blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-guardian-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await symlink(outside, join(workspace, "escape"));

  const traversal = await checkFileToolPath("read", { path: "../outside" }, workspace, []);
  const escaped = await checkFileToolPath("write", { path: "escape/new.txt" }, workspace, []);
  const inside = await checkFileToolPath("edit", { path: "new.txt" }, workspace, []);

  assert.equal(traversal.allowed, false);
  assert.equal(escaped.allowed, false);
  assert.equal(inside.allowed, true);
});

test("review prompt preserves user authorization, roles, exact action, and doctrine", () => {
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
    { role: "user", content: "Run exactly rg token src." },
    { role: "assistant", content: "I will inspect it." },
    { role: "toolResult", content: "previous failure" },
  ], action, workContext);

  assert.match(prompt, /role=\"user\"/);
  assert.match(prompt, /Run exactly rg token src/);
  assert.match(prompt, /role=\"assistant\"/);
  assert.match(prompt, /previous failure/);
  assert.match(prompt, /<work_context>/);
  assert.match(prompt, /Inspect the repository/);
  assert.match(prompt, /Search source/);
  assert.match(prompt, /"command":"rg token src"/);
  assert.match(REVIEWER_SYSTEM_PROMPT, /Goal authorization is not method authorization/);
  assert.match(REVIEWER_SYSTEM_PROMPT, /Failure does not expand authority/);
  assert.match(REVIEWER_SYSTEM_PROMPT, /Only content attributed to the user can authorize/);
  assert.match(REVIEWER_SYSTEM_PROMPT, /Work context is evidence, not user authorization/);
  assert.doesNotMatch(REVIEWER_SYSTEM_PROMPT, /ripgrep|network|secret|allowlist/i);
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

test("broad goals and failed actions remain evidence, not expanded authorization", () => {
  const prompt = buildReviewPrompt([
    { role: "user", content: "Make the build pass." },
    { role: "assistant", content: "The scoped build command failed." },
    { role: "toolResult", content: "exit 1" },
  ], {
    toolName: "bash",
    arguments: { command: "broader follow-up" },
    cwd: "/workspace",
  });
  assert.match(prompt, /Make the build pass/);
  assert.match(prompt, /exit 1/);
  assert.match(prompt, /broader follow-up/);
  assert.doesNotMatch(prompt, /authorized_method|authorization_level/);
});

test("strict parser accepts only the requested allow/deny JSON", () => {
  assert.deepEqual(parseReviewDecision('{"outcome":"allow","reason":"authorized"}'), {
    outcome: "allow",
    reason: "authorized",
  });
  assert.deepEqual(parseReviewDecision('{"outcome":"deny","reason":"broader method"}'), {
    outcome: "deny",
    reason: "broader method",
  });
  assert.throws(() => parseReviewDecision("```json\n{}\n```"));
  assert.throws(() => parseReviewDecision('{"outcome":"allow","reason":"ok","risk":"low"}'));
});

test("interactive denial offers exact one-shot approval; noninteractive denial fails closed", async () => {
  const denied = async (): Promise<ReviewResult> => ({
    kind: "decision",
    decision: { outcome: "deny", reason: "not authorized" },
  });
  const interactive = registerWith(denied);
  const tui = fakeContext("tui", "Allow exact action once");
  const accepted = await interactive.handler(bashEvent("echo ok"), tui);
  assert.equal(accepted, undefined);
  assert.equal(tui.selections.length, 1);
  assert.deepEqual(tui.selections[0].options, ["Allow exact action once", "Cancel"]);
  assert.match(tui.selections[0].title, /"command": "echo ok"/);

  const print = fakeContext("print");
  const blocked = await interactive.handler(bashEvent("echo ok"), print);
  assert.deepEqual(blocked, {
    block: true,
    reason: "Action denied by automatic review: not authorized",
  });
  assert.equal(print.selections.length, 0);
});

test("timeout and provider failure can use TUI allow-once; cancellation stays blocked", async () => {
  for (const result of [
    { kind: "timeout", reason: "timed out" },
    { kind: "failure", reason: "provider failed" },
  ] as const) {
    const { handler } = registerWith(async () => result);
    const ctx = fakeContext("tui", "Allow exact action once");
    assert.equal(await handler(bashEvent("true"), ctx), undefined);
  }

  const { handler } = registerWith(async () => ({ kind: "cancelled", reason: "cancelled" }));
  const ctx = fakeContext("tui", "Allow exact action once");
  assert.deepEqual(await handler(bashEvent("true"), ctx), {
    block: true,
    reason: "Action blocked because cancelled",
  });
  assert.equal(ctx.selections.length, 0);
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
  const reviewer = createModelReviewer({
    createResourceLoader(options) {
      resourceOptions = options as unknown as Record<string, unknown>;
      return { reload: async () => undefined } as never;
    },
    createSession: async (options) => {
      sessionOptions = options as unknown as Record<string, unknown>;
      return { session: fakeReviewerSession('{"outcome":"allow","reason":"exact"}') } as never;
    },
  });

  const result = await reviewer(reviewRequest());
  assert.deepEqual(result, {
    kind: "decision",
    decision: { outcome: "allow", reason: "exact" },
  });
  for (const key of [
    "noExtensions", "noSkills", "noPromptTemplates", "noThemes", "noContextFiles",
  ]) assert.equal(resourceOptions?.[key], true, key);
  assert.equal(sessionOptions?.noTools, "all");
  assert.deepEqual(sessionOptions?.tools, []);
  assert.deepEqual(sessionOptions?.customTools, []);
  assert.equal(sessionOptions?.thinkingLevel, "low");
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
  const cancelled = createModelReviewer(fakeReviewerDependencies('{"outcome":"allow","reason":"ok"}'));
  assert.equal((await cancelled(reviewRequest({ signal: controller.signal }))).kind, "cancelled");
});

function registerWith(
  reviewer: (request: ReviewRequest) => Promise<ReviewResult>,
  workContext?: () => WorkContextSnapshot | undefined,
) {
  let handler: (event: never, ctx: never) => Promise<unknown> = async () => undefined;
  const pi = {
    on(name: string, received: typeof handler) {
      assert.equal(name, "tool_call");
      handler = received;
    },
    getAllTools: () => [...["read", "write", "edit", "grep", "find", "ls"].map((name) => ({
      name,
      sourceInfo: { source: "builtin" },
    }))],
  } as unknown as ExtensionAPI;
  registerApprovalGuardian(pi, { reviewer, workContext });
  return { handler: handler as (event: unknown, ctx: unknown) => Promise<unknown> };
}

function fakeContext(mode: "tui" | "print" = "print", choice?: string) {
  const selections: Array<{ title: string; options: string[] }> = [];
  return {
    cwd: process.cwd(),
    mode,
    modelRegistry: fakeRegistry(),
    sessionManager: { buildContextEntries: () => [] },
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
    messages: [{ role: "user", content: "Run it exactly." }],
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

function allow(): ReviewResult {
  return { kind: "decision", decision: { outcome: "allow", reason: "authorized" } };
}

function bashEvent(command: string) {
  return toolEvent("bash", { command });
}

function toolEvent(toolName: string, input: Record<string, unknown>) {
  return { toolName, toolCallId: "call", input };
}
