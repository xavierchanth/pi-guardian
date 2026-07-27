import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { queryTerminalBackground, type QueryTerminalBackground } from "./src/ansi-theme/query.ts";
import { registerAnsiTheme } from "./src/ansi-theme/register.ts";
import {
  registerCapabilityController,
  SessionCapabilityController,
} from "./src/capabilities/index.ts";
import {
  createPiTaiConfigService,
  registerPiTaiConfig,
  type PiTaiConfigService,
} from "./src/config/register.ts";
import { registerCmux } from "./src/cmux/register.ts";
import { registerAutoCompaction } from "./src/compaction/register.ts";
import { registerFooter } from "./src/footer/register.ts";
import { registerApprovalGuardian } from "./src/guardian/register.ts";
import { registerFirstPartyKeybindings } from "./src/keybindings/register.ts";
import { registerModelProfiles } from "./src/model-profiles/register.ts";
import {
  registerNotifications,
  sendNativeTerminalNotification,
  type NotificationSender,
} from "./src/notifications/index.ts";
import { registerResponseEditor } from "./src/response-editor/register.ts";
import { generateModelTitle, type TitleGenerator } from "./src/session-title/generate.ts";
import { registerSessionTitle } from "./src/session-title/register.ts";
import { registerSubagents, type SubagentRuntimeMode } from "./src/subagents/register.ts";
import { registerWebTools } from "./src/web/register.ts";
import type { HostServiceClientPort } from "./src/concurrency/host-repository.ts";
import {
  createPiSessionWorkContextStore,
  type WorkContextStore,
} from "./src/work-context/persistence.ts";

export interface PiTaiRuntime {
  mode: Exclude<SubagentRuntimeMode, "legacy-child-process">;
  config: PiTaiConfigService;
  workContext: WorkContextStore;
  titleGenerator: TitleGenerator;
  queryTerminalBackground: QueryTerminalBackground;
  notificationSender: NotificationSender;
  capabilities: SessionCapabilityController;
  agentDir: string;
  hostServices?: HostServiceClientPort;
  rootSessionId?: string;
}

export type PiTaiRegistrar = (
  pi: ExtensionAPI,
  runtime: PiTaiRuntime,
) => void | Promise<void>;

export interface PiTaiRegistrars {
  keybindings: PiTaiRegistrar;
  config: PiTaiRegistrar;
  compaction: PiTaiRegistrar;
  capabilities: PiTaiRegistrar;
  workContext: PiTaiRegistrar;
  responseEditor: PiTaiRegistrar;
  webTools: PiTaiRegistrar;
  modelProfiles: PiTaiRegistrar;
  subagents: PiTaiRegistrar;
  sessionTitle: PiTaiRegistrar;
  cmux: PiTaiRegistrar;
  notifications: PiTaiRegistrar;
  guardian: PiTaiRegistrar;
  footer: PiTaiRegistrar;
  ansiTheme: PiTaiRegistrar;
}

const productionRegistrars: PiTaiRegistrars = {
  keybindings: (pi, runtime) => registerFirstPartyKeybindings(pi, runtime.agentDir),
  config: (pi, runtime) => registerPiTaiConfig(pi, runtime.config),
  compaction: (pi, runtime) => registerAutoCompaction(pi, runtime.config),
  capabilities: (pi, runtime) => registerCapabilityController(pi, runtime.capabilities),
  // I09: durable task tools are authoritative; update_plan remains injectable only for legacy test/package consumers.
  workContext: () => undefined,
  responseEditor: (pi) => {
    registerResponseEditor(pi);
  },
  webTools: (pi) => {
    registerWebTools(pi);
  },
  modelProfiles: (pi, runtime) => {
    registerModelProfiles(pi, runtime.config);
  },
  subagents: (pi, runtime) => {
    registerSubagents(pi, {
      runtime: runtime.mode,
      capabilities: runtime.capabilities,
      config: runtime.config,
      agentDir: runtime.agentDir,
      ...(runtime.hostServices ? { hostServices: runtime.hostServices } : {}),
      ...(runtime.rootSessionId ? { rootSessionId: runtime.rootSessionId } : {}),
    });
  },
  sessionTitle: (pi, runtime) => {
    registerSessionTitle(pi, runtime.config, runtime.titleGenerator);
  },
  cmux: async (pi, runtime) => {
    await registerCmux(pi, runtime.config);
  },
  notifications: (pi, runtime) => {
    registerNotifications(pi, runtime.config, runtime.notificationSender);
  },
  guardian: (pi, runtime) => registerApprovalGuardian(pi, {
    workContext: () => runtime.workContext.current(),
  }),
  footer: (pi, runtime) => {
    registerFooter(pi, runtime.workContext, runtime.capabilities);
  },
  ansiTheme: (pi, runtime) => {
    registerAnsiTheme(pi, runtime.config, runtime.queryTerminalBackground);
  },
};

function createProductionRuntime(): PiTaiRuntime {
  return {
    mode: "pi-cli",
    config: createPiTaiConfigService(),
    workContext: createPiSessionWorkContextStore(),
    titleGenerator: generateModelTitle,
    queryTerminalBackground,
    notificationSender: sendNativeTerminalNotification,
    capabilities: new SessionCapabilityController(),
    agentDir: getAgentDir(),
  };
}

export function createPiTaiExtension(
  registrars: PiTaiRegistrars = productionRegistrars,
  createRuntime: () => PiTaiRuntime = createProductionRuntime,
): (pi: ExtensionAPI) => Promise<void> {
  return async (pi) => {
    const runtime = createRuntime();
    await registrars.keybindings(pi, runtime);
    await registrars.config(pi, runtime);
    await registrars.compaction(pi, runtime);
    await registrars.capabilities(pi, runtime);
    await registrars.workContext(pi, runtime);
    await registrars.responseEditor(pi, runtime);
    await registrars.webTools(pi, runtime);
    await registrars.modelProfiles(pi, runtime);
    await registrars.subagents(pi, runtime);
    await registrars.sessionTitle(pi, runtime);
    await registrars.cmux(pi, runtime);
    await registrars.notifications(pi, runtime);
    await registrars.guardian(pi, runtime);
    await registrars.footer(pi, runtime);
    await registrars.ansiTheme(pi, runtime);
  };
}

export default createPiTaiExtension();
