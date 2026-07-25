import { mkdir } from "node:fs/promises";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { SessionPolicyReader } from "../config/register.ts";
import { registerAutoCompaction } from "../compaction/register.ts";
import type { AgentDefinitionSnapshot } from "../subagents/store.ts";
import { privateContextPaths } from "./persistence.ts";

type ModelRegistry = ExtensionContext["modelRegistry"];

export interface PrivateChildSessionRequest {
  contextId: string;
  cwd: string;
  stateRoot: string;
  agentDir?: string;
  agent: AgentDefinitionSnapshot;
  modelRegistry: ModelRegistry;
  systemPrompt: string;
  extensions?: readonly InlineExtension[];
  signal?: AbortSignal;
  sessionFile?: string;
}

export interface PrivateChildProtocolMessage {
  customType: string;
  content: string;
  details: unknown;
  delivery: "steer" | "followUp" | "nextTurn";
  triggerTurn: boolean;
}

export interface PrivateChildSessionHandle {
  readonly contextId: string;
  readonly session: AgentSession;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly sessionDir: string;
  readonly bridge: ExtensionAPI;
  send(message: PrivateChildProtocolMessage): void;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): void;
}

export interface PrivateChildSessionFactoryPort {
  create(request: PrivateChildSessionRequest): Promise<PrivateChildSessionHandle>;
}

export interface PrivateChildSessionFactoryDependencies {
  config: SessionPolicyReader;
  createSession?: typeof createAgentSession;
}

export class PrivateChildSessionFactory implements PrivateChildSessionFactoryPort {
  private readonly config: SessionPolicyReader;
  private readonly createSession: typeof createAgentSession;

  constructor(dependencies: PrivateChildSessionFactoryDependencies) {
    this.config = dependencies.config;
    this.createSession = dependencies.createSession ?? createAgentSession;
  }

  async create(request: PrivateChildSessionRequest): Promise<PrivateChildSessionHandle> {
    if (request.signal?.aborted) throw new Error("Private child launch was cancelled.");
    const paths = privateContextPaths(request.stateRoot, request.contextId);
    await mkdir(paths.sessions, { recursive: true, mode: 0o700 });
    let bridge: ExtensionAPI | undefined;
    const errors: string[] = [];
    const bridgeFactory: InlineExtension = {
      name: `pi-tai-child-bridge-${request.contextId}`,
      factory: (pi) => { bridge = pi; },
    };
    const compactionFactory: InlineExtension = {
      name: `pi-tai-child-compaction-${request.contextId}`,
      factory: (pi) => registerAutoCompaction(pi, this.config),
    };
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: request.cwd,
      agentDir: request.agentDir ?? getAgentDir(),
      settingsManager,
      extensionFactories: [bridgeFactory, compactionFactory, ...(request.extensions ?? [])],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => request.systemPrompt,
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload({ resolveProjectTrust: async () => true });
    const model = request.modelRegistry.find(request.agent.provider, request.agent.model);
    if (!model) throw new Error(`Child model not found: ${request.agent.provider}/${request.agent.model}`);
    const compatibility = request.modelRegistry as unknown as { runtime?: unknown; authStorage?: unknown };
    const options: Record<string, unknown> = {
      cwd: request.cwd,
      agentDir: request.agentDir ?? getAgentDir(),
      model,
      thinkingLevel: request.agent.effort,
      tools: [...request.agent.tools],
      resourceLoader,
      sessionManager: request.sessionFile
        ? SessionManager.open(request.sessionFile, paths.sessions, request.cwd)
        : SessionManager.create(request.cwd, paths.sessions),
      settingsManager,
    };
    if (compatibility.runtime) options.modelRuntime = compatibility.runtime;
    else {
      options.modelRegistry = request.modelRegistry;
      if (compatibility.authStorage) options.authStorage = compatibility.authStorage;
    }
    const created = await this.createSession(options as Parameters<typeof createAgentSession>[0]);
    try {
      await created.session.bindExtensions({
        mode: "rpc",
        shutdownHandler: () => {},
        onError: (error) => { errors.push(`${error.extensionPath}:${error.event}:${error.error}`); },
      });
      if (!bridge) throw new Error("Private child protocol bridge did not load.");
      if (errors.length) throw new Error(`Private child extension binding failed: ${errors.join("; ")}`);
      const sessionFile = created.session.sessionFile;
      if (!sessionFile) throw new Error("Private child session is not file-backed.");
      return new SdkPrivateChildSessionHandle(request.contextId, created.session, sessionFile, paths.sessions, bridge);
    } catch (error) {
      created.session.dispose();
      throw error;
    }
  }
}

class SdkPrivateChildSessionHandle implements PrivateChildSessionHandle {
  readonly contextId: string;
  readonly session: AgentSession;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly sessionDir: string;
  readonly bridge: ExtensionAPI;

  constructor(contextId: string, session: AgentSession, sessionFile: string, sessionDir: string, bridge: ExtensionAPI) {
    this.contextId = contextId;
    this.session = session;
    this.sessionId = session.sessionId;
    this.sessionFile = sessionFile;
    this.sessionDir = sessionDir;
    this.bridge = bridge;
  }

  send(message: PrivateChildProtocolMessage): void {
    this.bridge.sendMessage({
      customType: message.customType,
      content: message.content,
      display: false,
      details: message.details,
    }, { deliverAs: message.delivery, triggerTurn: message.triggerTurn });
  }

  abort(): Promise<void> { return this.session.abort(); }
  waitForIdle(): Promise<void> { return this.session.waitForIdle(); }
  dispose(): void { this.session.dispose(); }
}
