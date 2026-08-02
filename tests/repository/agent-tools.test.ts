import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { FileWorkspaceRegistry, JjCli } from "../../packages/pi-tai/src/core/isolation/index.ts";
import { WorkspaceManager } from "../../packages/pi-tai/src/core/isolation/manager.ts";
import { JjProcessExecutor } from "../../packages/pi-tai/src/core/jj/executor.ts";
import { StubBackend } from "../../packages/pi-tai/src/core/subagents/backends/stub.ts";
import { registerAgents } from "../../packages/pi-tai/src/core/subagents/register.ts";

const run = promisify(execFile);
const roots: string[] = [];

async function jj(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("jj", ["--no-pager", "--color=never", ...args], { cwd });
  return stdout;
}

/** Minimal stand-in for the pi extension host, capturing tools and hooks. */
function fakeHost() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const messages: any[] = [];
  const messageOptions: any[] = [];
  const commands = new Map<string, any>();
  const pi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    on(name: string, handler: (event: any, ctx: any) => any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    sendMessage(message: any, options: any) {
      messages.push(message);
      messageOptions.push(options);
    },
  };
  return { pi, tools, commands, handlers, messages, messageOptions };
}

/** A backend registered as "pi" whose children commit a described change. */
function writingBackend(file: string, contents: string): StubBackend {
  const backend = new StubBackend({ name: "pi" });
  const original = backend.spawn.bind(backend);
  backend.spawn = async (task) => {
    if (task.cwd.includes("pitai-")) {
      await writeFile(join(task.cwd, file), contents);
      await jj(task.cwd, "describe", "--message", `agent: add ${file}`);
      await jj(task.cwd, "new");
    }
    return original(task);
  };
  return backend;
}

async function harness(
  backend: StubBackend = new StubBackend({ name: "pi" }),
  options: { defaultBackend?: "pi" | "claude" | "codex" } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-tools-"));
  roots.push(root);
  const source = join(root, "repo");
  await mkdir(source, { recursive: true });
  await jj(source, "git", "init");
  await writeFile(join(source, "base.txt"), "base\n");
  await jj(source, "describe", "--message", "base commit");
  await jj(source, "new");

  const workspaces = new WorkspaceManager({
    jj: new JjCli(new JjProcessExecutor()),
    registry: new FileWorkspaceRegistry(join(root, "state")),
    sourcePath: source,
    workspaceRoot: join(root, "workspaces"),
  });
  const host = fakeHost();
  registerAgents(host.pi as never, {
    config: { session: () => ({}) } as never,
    agentDir: join(root, "agent-dir"),
    workspaces,
    extraBackends: [backend],
    ...(options.defaultBackend ? { defaultBackend: options.defaultBackend } : {}),
  });
  const ctx = {
    cwd: source,
    modelRegistry: { find: () => ({ id: "stub-model" }) },
    sessionManager: { getSessionId: () => "session-1" },
  };
  const call = async (name: string, params: Record<string, unknown> = {}) => {
    const tool = host.tools.get(name);
    assert.ok(tool, `tool ${name} is registered`);
    return tool.execute("call-1", params, undefined, undefined, ctx);
  };
  return { root, source, workspaces, host, ctx, call };
}

function textOf(result: any): string {
  return result.content.map((block: any) => block.text).join("\n");
}

describe("subagent tool surface", () => {
  before(async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "pi-tai-jjconfig-"));
    roots.push(configRoot);
    const configFile = join(configRoot, "config.toml");
    await writeFile(configFile, '[user]\nname = "Test"\nemail = "test@example.com"\n');
    process.env.JJ_CONFIG = configFile;
  });

  after(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });

  it("registers exactly the nine-tool surface", async () => {
    const { host } = await harness();

    assert.deepEqual([...host.tools.keys()].sort(), [
      "subagent_cancel",
      "subagent_check",
      "subagent_list",
      "subagent_send",
      "subagent_spawn",
      "subagent_wait",
      "workspace_discard",
      "workspace_merge",
      "workspace_status",
    ]);
    const guidance = host.tools.get("subagent_spawn").promptGuidelines.join("\n");
    assert.match(guidance, /sequential, not parallel/);
    assert.match(guidance, /`continue` naming the finished subagent/);
    assert.match(guidance, /shared index, manifest, README table, or numbered list/);
    assert.match(guidance, /images and attachment objects.*not inherited or forwarded/);
    assert.match(guidance, /user-authorized stable project path/);
    assert.match(
      guidance,
      /Before allowing the agent run to settle.*call subagent_wait.*Repeat until none remain/,
    );
    const spawnSchema = host.tools.get("subagent_spawn").parameters;
    assert.match(spawnSchema.properties.objective.description, /Text only/);
    assert.equal(spawnSchema.properties.objective.type, "string");
    assert.equal(spawnSchema.properties.acceptanceCriteria.items.type, "string");

    const wait = host.tools.get("subagent_wait");
    assert.equal(typeof wait.renderCall, "function");
    assert.equal(typeof wait.renderResult, "function");
    assert.match(wait.promptGuidelines.join("\n"), /already see subagent_wait results/);
  });

  it("offers every harness, so an unavailable one fails with a reason", async () => {
    const { host } = await harness();
    const schema = host.tools.get("subagent_spawn").parameters;

    const backendChoices = schema.properties.backend.anyOf.map((entry: any) => entry.const);
    assert.deepEqual(backendChoices, ["pi", "claude", "codex"]);
  });

  it("rejects temporary clipboard images in every prompt field before side effects", async () => {
    const backend = new StubBackend({ name: "pi" });
    const { call, workspaces } = await harness(backend);
    const image = "/tmp/pi-clipboard-123e4567-e89b-42d3-a456-426614174000.webp";
    const cases = [
      { objective: image },
      { objective: "review", background: `look at ${image}` },
      { objective: "review", acceptanceCriteria: [image] },
      { objective: "review", constraints: [image] },
      { objective: "review", title: image },
    ];

    for (const fields of cases) {
      const result = await call("subagent_spawn", { isolation: "workspace", ...fields });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Describe the image in text/);
      assert.match(textOf(result), /stable user-authorized project path/);
      assert.doesNotMatch(textOf(result), /\/tmp|pi-clipboard/);
    }
    assert.equal(backend.spawned.length, 0);
    assert.equal((await workspaces.list()).length, 0);
  });

  it("allows stable image paths and similar ordinary prose", async () => {
    const backend = new StubBackend({ name: "pi" });
    const { call, source } = await harness(backend);
    const stable = join(source, "pi-clipboard-123e4567-e89b-42d3-a456-426614174000.png");
    const result = await call("subagent_spawn", {
      isolation: "shared",
      objective: `Review ${stable}; discuss pi-clipboard-example.png as prose`,
    });
    assert.equal(result.isError, undefined);
    assert.equal(backend.spawned.length, 1);
  });

  it("rejects a model that is neither an alias nor a provider/model id", async () => {
    const { call } = await harness();

    const result = await call("subagent_spawn", {
      objective: "do a thing",
      isolation: "workspace",
      model: "gpt-9",
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /neither a known alias/);
  });

  it("applies capability defaults and injects its charter", async () => {
    const backend = new StubBackend({ name: "pi" });
    const { call } = await harness(backend);

    const result = await call("subagent_spawn", {
      objective: "research the implementation",
      isolation: "shared",
      capability: "researcher",
    });

    assert.equal(result.details.capability, "researcher");
    assert.equal(backend.spawned[0]?.model, "gpt-5.6-sol");
    assert.equal(backend.spawned[0]?.effort, "medium");
    assert.match(
      backend.spawned[0]?.systemPrompt ?? "",
      /<capability_instructions name="researcher">/,
    );
  });

  it("keeps the configured backend for explicit model IDs and rejects incompatible capability backends", async () => {
    const codex = new StubBackend({ name: "codex" });
    const { call } = await harness(codex, { defaultBackend: "codex" });

    const compatible = await call("subagent_spawn", {
      objective: "research",
      isolation: "shared",
      capability: "researcher",
      model: "openai-codex/custom",
    });
    assert.equal(compatible.isError, undefined);
    assert.equal(codex.spawned[0]?.model, "custom");

    const rejected = await call("subagent_spawn", {
      objective: "research",
      isolation: "shared",
      capability: "researcher",
      backend: "claude",
    });
    assert.equal(rejected.isError, true);
    assert.match(textOf(rejected), /cannot run on the claude backend/);
  });

  it("spawns an isolated subagent with a neutral delivery notice", async () => {
    const backend = new StubBackend({ name: "pi" });
    const { call, workspaces } = await harness(backend);

    const result = await call("subagent_spawn", {
      agent: "worker",
      objective: "add a feature",
      isolation: "workspace",
      acceptanceCriteria: ["tests pass"],
    });

    assert.equal(result.isError, undefined);
    assert.match(textOf(result), /in its own workspace/);
    assert.match(textOf(result), /Its result will arrive automatically\.$/);
    assert.doesNotMatch(textOf(result), /\b(?:wait|continue)\b/i);
    assert.equal((await workspaces.list()).length, 1);
    const charter = backend.spawned[0]?.systemPrompt ?? "";
    assert.match(charter, /your own checkout/, "the child is told where it is working");
    assert.match(charter, /jj describe/, "the child is told how to leave its commits");
    assert.match(charter, /tests pass/, "acceptance criteria reach the child");
    assert.ok(
      charter.includes(backend.spawned[0]!.cwd),
      "the charter names the directory the child works in",
    );
  });

  it("points a shared subagent at the working copy", async () => {
    const backend = new StubBackend({ name: "pi" });
    const { call, source } = await harness(backend);

    await call("subagent_spawn", { objective: "review the change", isolation: "shared" });

    assert.equal(backend.spawned[0]?.cwd, source);
    assert.match(backend.spawned[0]?.systemPrompt ?? "", /shared working copy/);
  });

  it("carries a finished subagent's report back through wait", async () => {
    const { call } = await harness();

    const spawned = await call("subagent_spawn", {
      objective: "add a feature",
      isolation: "workspace",
    });
    const id = spawned.details.id as string;
    const waited = await call("subagent_wait", { ids: [id] });

    assert.match(textOf(waited), new RegExp(`Subagent ${id}.*finished`, "s"));
    assert.match(textOf(waited), /done: add a feature/);
  });

  it("merges a finished subagent's work into the working copy", async () => {
    const { call, source, workspaces } = await harness(
      writingBackend("feature.txt", "agent output\n"),
    );

    const spawned = await call("subagent_spawn", {
      objective: "add a feature",
      isolation: "workspace",
    });
    const id = spawned.details.id as string;
    await call("subagent_wait", { ids: [id] });
    const merged = await call("workspace_merge", { id });

    assert.equal(merged.isError, undefined);
    assert.match(textOf(merged), /Merged 1 change\(s\)/);
    assert.equal(await readFile(join(source, "feature.txt"), "utf8"), "agent output\n");
    assert.deepEqual(await workspaces.list(), []);
  });

  it("honestly reports retained conflict custody and requires a retry", async () => {
    const { call, source, workspaces } = await harness(
      writingBackend("base.txt", "agent rewrite\n"),
    );
    const spawned = await call("subagent_spawn", {
      objective: "rewrite the base",
      isolation: "workspace",
    });
    const id = spawned.details.id as string;
    await call("subagent_wait", { ids: [id] });
    await writeFile(join(source, "base.txt"), "user rewrite\n");
    await jj(source, "describe", "--message", "user rewrite");
    await jj(source, "new");

    const retained = await call("workspace_merge", { id });

    assert.equal(retained.details.merged, false);
    assert.equal(retained.details.finalized, false);
    assert.equal(retained.details.custodyRetained, true);
    assert.match(textOf(retained), /Custody .* retained/i);
    assert.match(textOf(retained), /resolve the conflicts, then retry workspace_merge/i);
    assert.equal((await workspaces.list()).length, 1);
  });

  it("refuses to merge a subagent that is still running", async () => {
    const { call } = await harness();

    const spawned = await call("subagent_spawn", {
      objective: "HANG: keep going",
      isolation: "workspace",
    });
    const merged = await call("workspace_merge", { id: spawned.details.id });

    assert.equal(merged.isError, true);
    assert.match(textOf(merged), /still running/);
  });

  it("discards a subagent's work on request", async () => {
    const { call, source, workspaces } = await harness(
      writingBackend("scratch.txt", "throwaway\n"),
    );

    const spawned = await call("subagent_spawn", {
      objective: "try something",
      isolation: "workspace",
    });
    const id = spawned.details.id as string;
    await call("subagent_wait", { ids: [id] });
    const discarded = await call("workspace_discard", { id });

    assert.match(textOf(discarded), /Discarded/);
    assert.deepEqual(await workspaces.list(), []);
    await assert.rejects(readFile(join(source, "scratch.txt"), "utf8"));
  });

  it("reports workspaces and what they are holding", async () => {
    const { call } = await harness(writingBackend("feature.txt", "agent output\n"));

    const spawned = await call("subagent_spawn", {
      objective: "add a feature",
      isolation: "workspace",
    });
    await call("subagent_wait", { ids: [spawned.details.id] });
    const status = await call("workspace_status");

    assert.match(textOf(status), /pitai-.*active.*1 change\(s\)/);
  });

  it("lists and checks subagents without consuming their results", async () => {
    const { call, host, ctx } = await harness();

    const spawned = await call("subagent_spawn", {
      objective: "add a feature",
      isolation: "workspace",
    });
    const id = spawned.details.id as string;
    const checked = await call("subagent_check", { id });
    const listed = await call("subagent_list");

    assert.match(textOf(checked), /done: add a feature/);
    assert.match(textOf(listed), new RegExp(id));
    // The result was never consumed by wait, so it is still queued for delivery.
    await handlerFor(host, "agent_settled")({}, ctx);
    assert.equal(
      host.messages.length,
      1,
      "an unattended result is delivered when the parent goes idle",
    );
    assert.match(host.messages[0].content, /finished/);
  });

  it("nudges once per exchange to reassess waiting while a subagent runs", async () => {
    const { call, host, ctx } = await harness();
    const spawned = await call("subagent_spawn", {
      objective: "HANG: keep going",
      isolation: "workspace",
    });
    const settled = handlerFor(host, "agent_settled");
    const input = handlerFor(host, "input");

    await settled({}, ctx);
    assert.equal(host.messages.length, 1);
    assert.equal(host.messages[0].display, false);
    assert.equal(
      host.messages[0].content,
      `Subagents still running: ${spawned.details.id}. Reassess whether to wait.`,
    );
    assert.deepEqual(host.messageOptions[0], { deliverAs: "followUp", triggerTurn: true });

    await settled({}, ctx);
    assert.equal(host.messages.length, 1, "repeat settling does not recursively nudge");

    await input({ source: "extension" }, ctx);
    await settled({}, ctx);
    assert.equal(host.messages.length, 1, "extension input does not reset the recursion guard");

    await input({ source: "interactive" }, ctx);
    await settled({}, ctx);
    assert.equal(host.messages.length, 2, "foreground input makes reassessment eligible again");
    await call("subagent_cancel", { ids: [spawned.details.id] });
  });

  it("releases active waits only for foreground input", async () => {
    const { call, host, ctx } = await harness();
    const spawned = await call("subagent_spawn", {
      objective: "HANG: keep going",
      isolation: "workspace",
    });
    const waiting = call("subagent_wait", { ids: [spawned.details.id] });
    const input = handlerFor(host, "input");

    assert.deepEqual(await input({ source: "extension" }, ctx), { action: "continue" });
    const extensionOutcome = await Promise.race([
      waiting.then(() => "released"),
      new Promise<string>((resolve) => setTimeout(() => resolve("still-waiting"), 10)),
    ]);
    assert.equal(extensionOutcome, "still-waiting");

    assert.deepEqual(await input({ source: "interactive" }, ctx), { action: "continue" });
    const result = await waiting;
    assert.equal(result.details.reason, "user-interrupted");
    assert.deepEqual(result.details.pending, [spawned.details.id]);
    await call("subagent_cancel", { ids: [spawned.details.id] });
  });

  it("cancels a running subagent and keeps its workspace for inspection", async () => {
    const { call, workspaces } = await harness(writingBackend("partial.txt", "half done\n"));

    const spawned = await call("subagent_spawn", {
      objective: "HANG: keep going",
      isolation: "workspace",
    });
    const cancelled = await call("subagent_cancel", { ids: [spawned.details.id] });

    assert.match(textOf(cancelled), /workspaces are kept/);
    assert.equal((await workspaces.list()).length, 1, "cancelling does not throw the work away");
  });
});

function handlerFor(host: ReturnType<typeof fakeHost>, name: string) {
  const handler = host.handlers.get(name)?.[0];
  assert.ok(handler, `handler ${name} is registered`);
  return handler!;
}

describe("workspace continuation", () => {
  it("sends a second subagent into a cancelled one's workspace", async () => {
    const { call, host, workspaces } = await harness(writingBackend("partial.txt", "half done\n"));

    const first = await call("subagent_spawn", {
      objective: "HANG: long job",
      isolation: "workspace",
      capability: "researcher",
    });
    await call("subagent_cancel", { ids: [first.details.id] });
    const workspaceId = first.details.workspaceId;
    const second = await call("subagent_spawn", {
      objective: "finish the long job",
      isolation: "workspace",
      continue: first.details.id,
    });

    assert.equal(second.details.capability, "researcher", "an omitted capability is inherited");
    assert.equal(
      second.details.workspaceId,
      workspaceId,
      "the second subagent inherits the same checkout",
    );
    assert.equal((await workspaces.list()).length, 1, "no second workspace was created");
    const backend = host.tools.get("subagent_spawn") && undefined;
    assert.equal(backend, undefined);
  });

  it("rejects only an explicitly conflicting continuation capability", async () => {
    const { call } = await harness();
    const first = await call("subagent_spawn", {
      objective: "HANG: plain job",
      isolation: "workspace",
    });
    await call("subagent_cancel", { ids: [first.details.id] });

    const result = await call("subagent_spawn", {
      objective: "change its specialization",
      isolation: "workspace",
      capability: "researcher",
      continue: first.details.id,
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /must retain capability/);
  });

  it("refuses to continue into a workspace whose subagent is still running", async () => {
    const { call } = await harness();

    const first = await call("subagent_spawn", {
      objective: "HANG: long job",
      isolation: "workspace",
    });
    const second = await call("subagent_spawn", {
      objective: "take over",
      isolation: "workspace",
      continue: first.details.id,
    });

    assert.equal(second.isError, true);
    assert.match(textOf(second), /still running; cancel it/);
  });

  it("tells a continuing subagent to read what is already there", async () => {
    const backend = writingBackend("partial.txt", "half done\n");
    const { call } = await harness(backend);

    const first = await call("subagent_spawn", {
      objective: "HANG: long job",
      isolation: "workspace",
    });
    await call("subagent_cancel", { ids: [first.details.id] });
    await call("subagent_spawn", {
      objective: "finish it",
      isolation: "workspace",
      continue: first.details.id,
    });

    assert.match(
      backend.spawned.at(-1)?.systemPrompt ?? "",
      /continuing work another subagent started/,
    );
  });
});

describe("root session instructions", () => {
  it("injects pi-tai instructions and the root role prompt", async () => {
    const { host, ctx } = await harness();
    const composed = await handlerFor(host, "before_agent_start")(
      { systemPrompt: "BASE PROMPT" },
      ctx,
    );

    assert.match(composed.systemPrompt, /^BASE PROMPT/, "the host's own prompt stays first");
    assert.match(composed.systemPrompt, /<pi_tai_instructions>/);
  });
});
