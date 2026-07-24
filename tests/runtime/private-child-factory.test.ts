import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiTaiConfigService } from "../../packages/pi-tai/src/config/register.ts";
import { PrivateChildSessionFactory } from "../../packages/pi-tai/src/concurrency/child-session.ts";
import { Type } from "typebox";
import type { AgentDefinitionSnapshot } from "../../packages/pi-tai/src/subagents/store.ts";

function agent(provider: string): AgentDefinitionSnapshot {
  return {
    name: "worker", description: "worker", root: false, provider, model: "scripted", effort: "low",
    tools: ["child_echo"], allowedChildren: [], uncertaintyHandling: "best-effort", systemPrompt: "work",
    source: "packaged", filePath: "worker.md", contentHash: "hash",
  };
}

test("private child factory creates a hidden file-backed SDK context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-child-factory-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
  const faux = fauxProvider({
    provider: "pi-tai-factory-faux",
    models: [{ id: "scripted", name: "Scripted", reasoning: true }],
    tokensPerSecond: 200,
  });
  const provider = faux.provider;
  runtime.registerProvider(provider.id, {
    name: provider.name, baseUrl: "http://faux.invalid", apiKey: "faux", api: faux.api,
    streamSimple: provider.streamSimple.bind(provider), models: faux.models,
  });
  await runtime.setRuntimeApiKey(provider.id, "faux");
  const registry = {
    runtime,
    find: (providerId: string, modelId: string) => runtime.getModel(providerId, modelId),
  } as unknown as ExtensionContext["modelRegistry"];
  const factory = new PrivateChildSessionFactory({ config: createPiTaiConfigService(agentDir) });
  const handle = await factory.create({
    contextId: "child-1", cwd, stateRoot: join(agentDir, "pi-tai", "subagents"), agentDir,
    agent: agent(provider.id), modelRegistry: registry, systemPrompt: "Private worker prompt.",
    extensions: [{
      name: "child-tools",
      factory: (pi) => pi.registerTool({
        name: "child_echo", label: "Child Echo", description: "Echo", parameters: Type.Object({ text: Type.String() }),
        async execute(_id, params) { return { content: [{ type: "text", text: params.text }], details: {} }; },
      }),
    }],
  });
  try {
    assert.ok(handle.sessionFile.includes("/contexts/child-1/sessions/"));
    assert.deepEqual(handle.session.getActiveToolNames(), ["child_echo"]);
    assert.deepEqual(await SessionManager.list(cwd, join(root, "root-sessions")), []);
    faux.setResponses([(context) => fauxAssistantMessage(
      JSON.stringify(context.messages).includes("quiet-continue") ? "custom-seen" : "custom-missing",
    )]);
    handle.send({
      customType: "pi-tai-parent-message-v1", content: "quiet-continue", details: { kind: "continue" },
      delivery: "steer", triggerTurn: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await handle.waitForIdle();
    assert.ok(handle.session.messages.some((message) => message.role === "custom" && message.customType === "pi-tai-parent-message-v1"));
    assert.equal(handle.session.messages.some((message) => message.role === "user" && JSON.stringify(message).includes("quiet-continue")), false);
  } finally {
    handle.dispose();
  }
});
