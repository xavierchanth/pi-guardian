import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxProviderHandle,
} from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import type {
  ModelInfo,
  RuntimeCapabilities,
  SessionCreateParams,
  SessionInfo,
  SessionOpenParams,
  SessionPromptParams,
  SessionRelocateWorkspaceParams,
  SessionSetCapabilityParams,
  SessionSetModelParams,
  SessionSetThinkingParams,
  SessionTextParams,
  ThinkingInfo,
} from "@pi-tai/runtime-protocol";
import type { SessionPolicy } from "../../../packages/pi-tai/src/config/schema.ts";
import type { ConfigProvenance } from "../../../packages/pi-tai/src/config/provenance.ts";
import { join } from "node:path";
import { createPiTaiExtension } from "../../../packages/pi-tai/pi-tai.ts";
import { SessionCapabilityController } from "../../../packages/pi-tai/src/capabilities/controller.ts";
import { createPinnedPiTaiConfigService } from "../../../packages/pi-tai/src/config/register.ts";
import { createPiSessionWorkContextStore } from "../../../packages/pi-tai/src/work-context/persistence.ts";
import { HostRepositoryEnrollmentStore, RepositoryEnrollmentService } from "../../../packages/pi-tai/src/jj/repository-enrollment.ts";
import { HostRepositoryMutationCoordinator, HostSessionWorkspaceStore, SessionWorkspaceService } from "../../../packages/pi-tai/src/jj/session-workspace.ts";
import type { DiagnosticSink } from "./diagnostics.ts";
import type { HostServicePort } from "./host-services.ts";
import { mapAgentSessionEvent } from "./event-map.ts";
import { createHeadlessUiContext } from "./headless-ui.ts";
import type { PromptStart, RuntimeEventSink, RuntimePort } from "./runtime-port.ts";

export interface PinnedSessionPolicy {
  policy: SessionPolicy;
  provenance: ConfigProvenance;
}

export class PiSdkRuntimePort implements RuntimePort {
  private modelRuntime?: ModelRuntime;
  private faux?: FauxProviderHandle;
  private agentDir?: string;
  private runtime?: AgentSessionRuntime;
  private unsubscribe?: () => void;
  private extensionErrors: string[] = [];
  private capabilityController?: SessionCapabilityController;
  private active?: { commandId: string; turnId: string; emit: RuntimeEventSink };
  private hostServices?: HostServicePort;
  private rootSessionId?: string;
  private pinnedPolicy?: PinnedSessionPolicy;
  private readonly diagnostics: DiagnosticSink;

  constructor(diagnostics: DiagnosticSink = () => {}) {
    this.diagnostics = diagnostics;
  }

  bindHostServices(services: HostServicePort): void { this.hostServices = services; }

  sessionPolicy(): SessionPolicy | undefined { return this.pinnedPolicy?.policy; }

  async capabilities(): Promise<RuntimeCapabilities> {
    if (!this.runtime) {
      return {
        methods: [],
        tools: [],
        commands: ["continue"],
        sessionCapabilities: [],
        extensionErrors: [...this.extensionErrors],
      };
    }
    const extensionRuntime = this.runtime.services.resourceLoader.getExtensions().runtime;
    return {
      methods: [],
      tools: this.runtime.session.getAllTools().map((tool) => tool.name).sort(),
      commands: extensionRuntime.getCommands().map((command) => command.name).sort(),
      sessionCapabilities: this.capabilityController?.snapshot().capabilities.map((capability) => ({
        id: capability.id,
        available: capability.available,
        serviceEnabled: capability.serviceEnabled,
        toolsExposed: capability.toolsExposed,
        ...(capability.reason ? { reason: capability.reason } : {}),
      })) ?? [],
      extensionErrors: [...this.extensionErrors],
    };
  }

  async createSession(params: SessionCreateParams, emit: RuntimeEventSink): Promise<SessionInfo> {
    await this.disposeSession();
    await this.ensureModelRuntime(params.agentDir, params.faux ?? false);
    this.rootSessionId = params.rootSessionId ?? undefined;
    this.pinnedPolicy = {
      policy: params.sessionPolicy as SessionPolicy,
      provenance: params.policyProvenance as ConfigProvenance,
    };
    const cwd = await this.managedSessionCwd(params);
    const sessionManager = SessionManager.create(cwd, params.sessionDir);
    this.runtime = await this.createRuntime(cwd, params.agentDir, sessionManager);
    await this.bindSession(this.runtime.session);
    const info = sessionInfo(this.runtime.session, cwd);
    emit({
      event: "session.ready",
      sessionId: info.sessionId,
      data: { ...info, capabilities: await this.capabilities() },
    });
    return info;
  }

  async openSession(params: SessionOpenParams, emit: RuntimeEventSink): Promise<SessionInfo> {
    await this.disposeSession();
    this.rootSessionId = params.rootSessionId ?? undefined;
    this.pinnedPolicy = {
      policy: params.sessionPolicy as SessionPolicy,
      provenance: params.policyProvenance as ConfigProvenance,
    };
    await this.ensureModelRuntime(params.agentDir, params.faux ?? false);
    const sessionManager = SessionManager.open(params.sessionFile, params.sessionDir);
    this.runtime = await this.createRuntime(sessionManager.getCwd(), params.agentDir, sessionManager);
    await this.bindSession(this.runtime.session);
    const info = sessionInfo(this.runtime.session, this.runtime.cwd);
    emit({
      event: "session.replaced",
      sessionId: info.sessionId,
      data: { ...info, capabilities: await this.capabilities() },
    });
    return info;
  }

  async startPrompt(
    params: SessionPromptParams,
    commandId: string,
    emit: RuntimeEventSink,
  ): Promise<PromptStart> {
    const session = this.requireSession();
    if (this.active) throw new Error("A Pi prompt is already active.");
    this.configureFauxResponses(params.text);
    this.active = { commandId, turnId: params.turnId, emit };
    let resolvePreflight!: (accepted: boolean) => void;
    const preflight = new Promise<boolean>((resolve) => { resolvePreflight = resolve; });
    const completion = session.prompt(params.text, {
      source: "rpc",
      preflightResult: resolvePreflight,
    }).finally(() => {
      if (this.active?.turnId === params.turnId) this.active = undefined;
    });
    completion.catch(() => undefined);
    const accepted = await Promise.race([
      preflight,
      completion.then(() => false, () => false),
    ]);
    return { accepted, completion };
  }

  async steer(params: SessionTextParams): Promise<boolean> {
    await this.requireSession().steer(params.text);
    return true;
  }

  async followUp(params: SessionTextParams): Promise<boolean> {
    await this.requireSession().followUp(params.text);
    return true;
  }

  async cancel(turnId: string): Promise<boolean> {
    if (!this.active || this.active.turnId !== turnId) return false;
    await this.requireSession().abort();
    return true;
  }

  async setModel(params: SessionSetModelParams): Promise<ModelInfo> {
    const model = this.modelRuntime?.getModel(params.provider, params.model);
    if (!model) throw new Error(`Model not found: ${params.provider}/${params.model}`);
    await this.requireSession().setModel(model);
    return { provider: model.provider, model: model.id };
  }

  async setThinking(params: SessionSetThinkingParams): Promise<ThinkingInfo> {
    const session = this.requireSession();
    session.setThinkingLevel(params.level);
    return { level: session.thinkingLevel };
  }

  async setCapability(
    params: SessionSetCapabilityParams,
    emit: RuntimeEventSink,
  ): Promise<RuntimeCapabilities> {
    const known = this.capabilityController?.snapshot().capabilities.some(
      (capability) => capability.id === params.capabilityId,
    );
    if (!known) throw new Error(`Unknown capability: ${params.capabilityId}`);
    await this.requireSession().prompt(
      `/${params.capabilityId} ${params.enabled ? "on" : "off"}`,
      { source: "rpc" },
    );
    const capabilities = await this.capabilities();
    emit({
      event: "session.capabilities_changed",
      sessionId: this.requireSession().sessionId,
      data: { capabilities },
    });
    return capabilities;
  }

  async relocateWorkspace(
    _params: SessionRelocateWorkspaceParams,
    _emit: RuntimeEventSink,
  ): Promise<SessionInfo> {
    throw new Error(
      "Direct hosted workspace relocation is disabled; ask the agent for a workspace or start Pi from the created workspace path.",
    );
  }

  async disposeSession(): Promise<void> {
    this.active = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.runtime) await this.runtime.dispose();
    this.runtime = undefined;
    this.capabilityController = undefined;
  }

  async shutdown(): Promise<void> {
    await this.disposeSession();
  }

  private async managedSessionCwd(params: SessionCreateParams): Promise<string> {
    const rootSessionId = params.rootSessionId ?? undefined;
    if (!this.hostServices || !rootSessionId) return params.cwd;
    const enrollments = new RepositoryEnrollmentService({ store: new HostRepositoryEnrollmentStore(this.hostServices) });
    let enrollment;
    try { enrollment = await enrollments.verify(params.cwd); }
    catch { return params.cwd; }
    const service = new SessionWorkspaceService({
      store: new HostSessionWorkspaceStore(this.hostServices, rootSessionId),
      coordinator: new HostRepositoryMutationCoordinator(this.hostServices),
    });
    const identity = await service.allocate({ enrollment, invokingCwd: params.cwd, rootSessionId, runtimeGeneration: params.runtimeGeneration ?? 1 });
    return identity.path;
  }

  private async ensureModelRuntime(agentDir: string, faux: boolean): Promise<void> {
    if (!faux) throw new Error("H2 proof runtime currently requires faux: true.");
    if (this.agentDir && this.agentDir !== agentDir) {
      throw new Error("Worker generation cannot change agentDir.");
    }
    if (this.modelRuntime) return;
    this.agentDir = agentDir;
    this.modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    this.faux = fauxProvider({
      provider: "pi-tai-faux",
      models: [{ id: "scripted", name: "Pi-Tai Faux", reasoning: true }],
      tokensPerSecond: 40,
      tokenSize: { min: 2, max: 5 },
    });
    const provider = this.faux.provider;
    this.modelRuntime.registerProvider(provider.id, {
      name: provider.name,
      baseUrl: "http://faux.invalid",
      apiKey: "pi-tai-faux",
      api: this.faux.api,
      streamSimple: provider.streamSimple.bind(provider),
      models: this.faux.models.map((model) => ({
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
    await this.modelRuntime.setRuntimeApiKey(provider.id, "pi-tai-faux");
  }

  private async createRuntime(
    cwd: string,
    agentDir: string,
    sessionManager: SessionManager,
  ): Promise<AgentSessionRuntime> {
    const modelRuntime = this.modelRuntime;
    const model = this.faux?.getModel();
    if (!modelRuntime || !model) throw new Error("Faux model runtime is unavailable.");
    const hostedExtension = createPiTaiExtension(undefined, () => {
      const capabilities = new SessionCapabilityController();
      this.capabilityController = capabilities;
      return {
        mode: "host-worker",
        config: createPinnedPiTaiConfigService(
          this.pinnedPolicy?.policy ?? failMissingPinnedPolicy(),
          this.pinnedPolicy?.provenance ?? failMissingPinnedPolicy(),
        ),
        workContext: createPiSessionWorkContextStore(),
        titleGenerator: async () => "Hosted session",
        queryTerminalBackground: async () => { throw new Error("TTY access is disabled in hosted mode."); },
        notificationSender: () => {},
        capabilities,
        agentDir,
        ...(this.hostServices ? { hostServices: this.hostServices } : {}),
        ...(this.rootSessionId ? { rootSessionId: this.rootSessionId } : {}),
      };
    });
    const factory: CreateAgentSessionRuntimeFactory = async (options) => {
      const services = await createAgentSessionServices({
        cwd: options.cwd,
        agentDir,
        modelRuntime,
        resourceLoaderOptions: {
          extensionFactories: [{ name: "pi-tai-hosted", factory: hostedExtension }],
          promptsOverride: () => ({
            prompts: [
              {
                name: "continue",
                description: "Continue the agent's previous work",
                content: "Continue what you were doing.",
                filePath: "pi-tai:continue",
                sourceInfo: {
                  path: "pi-tai:continue",
                  source: "pi-tai-runtime",
                  scope: "temporary",
                  origin: "top-level",
                },
              },
            ],
            diagnostics: [],
          }),
          noSkills: true,
          noThemes: true,
          noContextFiles: true,
        },
        resourceLoaderReloadOptions: {
          resolveProjectTrust: async () => true,
        },
      });
      const created = await createAgentSessionFromServices({
        services,
        sessionManager: options.sessionManager,
        sessionStartEvent: options.sessionStartEvent,
        model,
        thinkingLevel: "off",
        noTools: "builtin",
      });
      this.extensionErrors.push(
        ...created.extensionsResult.errors.map((error) => `${error.path}: ${error.error}`),
      );
      return { ...created, services, diagnostics: services.diagnostics };
    };
    const runtime = await createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager });
    runtime.setRebindSession((session) => this.bindSession(session));
    return runtime;
  }

  private async bindSession(session: AgentSession): Promise<void> {
    this.unsubscribe?.();
    const runtime = this.runtime;
    if (!runtime) throw new Error("Session runtime is unavailable during extension binding.");
    await session.bindExtensions({
      mode: "rpc",
      uiContext: createHeadlessUiContext(this.diagnostics),
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: async (options) => runtime.newSession(options),
        fork: async (entryId, options) => {
          const result = await runtime.fork(entryId, options);
          return { cancelled: result.cancelled };
        },
        navigateTree: async (targetId, options) => session.navigateTree(targetId, options),
        switchSession: async (sessionPath, options) => runtime.switchSession(sessionPath, options),
        reload: async () => session.reload(),
      },
      onError: (error) => {
        this.extensionErrors.push(`${error.extensionPath}:${error.event}:${error.error}`);
      },
      shutdownHandler: () => {},
    });
    this.unsubscribe = session.subscribe((event) => {
      if (!this.active) return;
      const mapped = mapAgentSessionEvent(event, {
        commandId: this.active.commandId,
        sessionId: session.sessionId,
        turnId: this.active.turnId,
      });
      if (mapped) this.active.emit(mapped);
    });
  }

  private configureFauxResponses(prompt: string): void {
    if (!this.faux) throw new Error("Faux provider is unavailable.");
    if (prompt.includes("use update_plan")) {
      this.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("update_plan", {
          goal: "Prove hosted runtime",
          plan: [{ content: "Run faux prompt", status: "in_progress" }],
        }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Plan recorded by the hosted runtime."),
      ]);
      return;
    }
    this.faux.setResponses([
      (context) => {
        const history = JSON.stringify(context.messages);
        const prefix = prompt.includes("verify history") && history.includes("first persisted turn")
          ? "history-present"
          : "faux";
        const text = prompt.includes("slow")
          ? `${prefix} ${"streaming ".repeat(80)}`
          : `${prefix} response`;
        return fauxAssistantMessage(text);
      },
    ]);
  }

  private requireSession(): AgentSession {
    if (!this.runtime) throw new Error("No Pi session is loaded.");
    return this.runtime.session;
  }
}

function failMissingPinnedPolicy(): never {
  throw new Error("Host-managed sessions require pinned session policy and provenance.");
}

function sessionInfo(session: AgentSession, cwd: string): SessionInfo {
  if (!session.sessionFile) throw new Error("Hosted Pi session is not persistent.");
  return { sessionId: session.sessionId, sessionFile: session.sessionFile, cwd };
}
