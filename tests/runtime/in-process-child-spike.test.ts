import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type AgentSession,
  type AgentSessionServices,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

interface PrivateChild {
  session: AgentSession;
  services: AgentSessionServices;
  faux: FauxProviderHandle;
  bridge: ExtensionAPI;
  sessionDir: string;
  compactionThresholdPercent: 90;
}

async function createPrivateChild(root: string, name: string): Promise<PrivateChild> {
  const cwd = join(root, name, "workspace");
  const agentDir = join(root, name, "agent");
  const sessionDir = join(root, "private-child-sessions", name);
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
  ]);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const faux = fauxProvider({
    provider: `pi-tai-faux-${name}`,
    models: [{ id: "scripted", name: `Faux ${name}`, reasoning: true }],
    tokensPerSecond: 200,
    tokenSize: { min: 2, max: 5 },
  });
  const provider = faux.provider;
  modelRuntime.registerProvider(provider.id, {
    name: provider.name,
    baseUrl: "http://faux.invalid",
    apiKey: "pi-tai-faux",
    api: faux.api,
    streamSimple: provider.streamSimple.bind(provider),
    models: faux.models.map((model) => ({
      id: model.id,
      name: model.name,
      api: model.api,
      baseUrl: model.baseUrl,
      reasoning: model.reasoning,
      thinkingLevelMap: model.thinkingLevelMap,
      input: [...model.input],
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      headers: model.headers,
      compat: model.compat,
    })),
  });
  await modelRuntime.setRuntimeApiKey(provider.id, "pi-tai-faux");

  let bridge: ExtensionAPI | undefined;
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: false },
  });
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    resourceLoaderOptions: {
      extensionFactories: [
        {
          name: `private-child-bridge-${name}`,
          factory: (pi) => {
            bridge = pi;
          },
        },
      ],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => `You are private child ${name}.`,
    },
    resourceLoaderReloadOptions: { resolveProjectTrust: async () => true },
  });
  const created = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.create(cwd, sessionDir),
    model: faux.getModel(),
    thinkingLevel: "off",
    noTools: "all",
  });
  if (!bridge) throw new Error("Private child bridge extension did not load.");
  return {
    session: created.session,
    services,
    faux,
    bridge,
    sessionDir,
    compactionThresholdPercent: 90,
  };
}

function assistantText(session: AgentSession): string {
  return session.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content)
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("two private AgentSession children run concurrently and receive typed custom messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-private-children-"));
  const rootSessionDir = join(root, "root-sessions");
  await mkdir(rootSessionDir, { recursive: true });
  const [left, right] = await Promise.all([
    createPrivateChild(root, "left"),
    createPrivateChild(root, "right"),
  ]);
  try {
    left.faux.setResponses([fauxAssistantMessage(`left ${"streaming ".repeat(30)}`)]);
    right.faux.setResponses([fauxAssistantMessage(`right ${"streaming ".repeat(30)}`)]);
    await Promise.all([left.session.prompt("run left"), right.session.prompt("run right")]);
    assert.match(assistantText(left.session), /left streaming/);
    assert.match(assistantText(right.session), /right streaming/);
    assert.notEqual(left.session.model?.provider, right.session.model?.provider);
    assert.deepEqual(left.session.getAllTools(), []);
    assert.deepEqual(right.session.getAllTools(), []);
    assert.match(left.services.cwd, /left\/workspace$/);
    assert.match(right.services.cwd, /right\/workspace$/);

    left.faux.setResponses([
      fauxAssistantMessage(`active ${"streaming ".repeat(100)}`),
      (context) =>
        fauxAssistantMessage(
          JSON.stringify(context.messages).includes("active-steer")
            ? "active-steer-seen"
            : "active-steer-missing",
        ),
    ]);
    const activePrompt = left.session.prompt("start active turn");
    await delay(10);
    left.bridge.sendMessage(
      {
        customType: "pi-tai-child-event",
        content: "active-steer",
        display: false,
        details: { childContextId: "child-left" },
      },
      { deliverAs: "steer", triggerTurn: true },
    );
    await activePrompt;
    assert.match(assistantText(left.session), /active-steer-seen/);

    left.faux.setResponses([
      (context) =>
        fauxAssistantMessage(
          JSON.stringify(context.messages).includes("continue-left")
            ? "left-custom-seen"
            : "left-custom-missing",
        ),
    ]);
    left.bridge.sendMessage(
      {
        customType: "pi-tai-parent-message",
        content: "continue-left",
        display: false,
        details: { parentContextId: "root" },
      },
      { deliverAs: "steer", triggerTurn: true },
    );
    await delay(10);
    await left.session.waitForIdle();
    assert.match(assistantText(left.session), /left-custom-seen/);
    assert.ok(
      left.session.messages.some(
        (message) => message.role === "custom" && message.customType === "pi-tai-parent-message",
      ),
    );
    assert.equal(
      left.session.messages.some(
        (message) => message.role === "user" && JSON.stringify(message).includes("continue-left"),
      ),
      false,
    );

    assert.equal(left.services.settingsManager.getCompactionEnabled(), true);
    assert.equal(right.services.settingsManager.getCompactionEnabled(), true);
    assert.equal(left.compactionThresholdPercent, 90);
    assert.equal(right.compactionThresholdPercent, 90);
    assert.notEqual(left.services.settingsManager, right.services.settingsManager);

    const visibleRootSessions = await SessionManager.list(
      join(root, "left", "workspace"),
      rootSessionDir,
    );
    assert.deepEqual(visibleRootSessions, []);
    assert.ok(left.session.sessionFile?.startsWith(left.sessionDir));
    assert.ok(right.session.sessionFile?.startsWith(right.sessionDir));
  } finally {
    left.session.dispose();
    right.session.dispose();
  }
});

test("private child journal reopens from its private session directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-private-child-reopen-"));
  const child = await createPrivateChild(root, "reopen");
  child.faux.setResponses([fauxAssistantMessage("durable-private-history")]);
  await child.session.prompt("persist this child turn");
  const sessionFile = child.session.sessionFile;
  assert.ok(sessionFile);
  child.session.dispose();

  const reopened = await createAgentSessionFromServices({
    services: child.services,
    sessionManager: SessionManager.open(sessionFile, child.sessionDir),
    model: child.faux.getModel(),
    thinkingLevel: "off",
    noTools: "all",
  });
  try {
    assert.match(assistantText(reopened.session), /durable-private-history/);
    assert.equal(reopened.session.sessionFile, sessionFile);
  } finally {
    reopened.session.dispose();
  }
});

test("cancelling and disposing one private child does not affect its sibling", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-private-child-cancel-"));
  const [left, right] = await Promise.all([
    createPrivateChild(root, "left"),
    createPrivateChild(root, "right"),
  ]);
  try {
    left.faux.setResponses([fauxAssistantMessage(`left ${"very-long ".repeat(300)}`)]);
    right.faux.setResponses([fauxAssistantMessage("right-complete")]);
    const leftPrompt = left.session.prompt("long left");
    await delay(20);
    await left.session.abort();
    await leftPrompt.catch(() => undefined);
    await right.session.prompt("short right");
    assert.match(assistantText(right.session), /right-complete/);

    left.session.dispose();
    right.faux.setResponses([fauxAssistantMessage("right-after-left-dispose")]);
    await right.session.prompt("continue right");
    assert.match(assistantText(right.session), /right-after-left-dispose/);
  } finally {
    right.session.dispose();
  }
});
