import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { queryTerminalBackground, type QueryTerminalBackground } from "./src/terminal/ansi-theme/query.ts";
import { registerAnsiTheme } from "./src/terminal/ansi-theme/register.ts";
import {
  registerCapabilityController,
  SessionCapabilityController,
} from "./src/capabilities/index.ts";
import {
  createPiTaiConfigService,
  registerPiTaiConfig,
  type PiTaiConfigService,
} from "./src/core/config/register.ts";
import { registerCmux } from "./src/terminal/cmux/register.ts";
import { registerAutoCompaction } from "./src/core/compaction/register.ts";
import { registerContextTransfer } from "./src/core/context-transfer/register.ts";
import { registerFooter } from "./src/terminal/footer/register.ts";
import { registerApprovalGuardian } from "./src/core/guardian/register.ts";
import { registerFirstPartyKeybindings } from "./src/terminal/keybindings/register.ts";
import { registerModelProfiles } from "./src/core/model-profiles/register.ts";
import {
  registerNotifications,
  sendNativeTerminalNotification,
  type NotificationSender,
} from "./src/terminal/notifications/index.ts";
import { registerResponseEditor } from "./src/terminal/response-editor/register.ts";
import { generateModelTitle, type TitleGenerator } from "./src/session-title/generate.ts";
import { registerSessionTitle } from "./src/session-title/register.ts";
import { registerBtw } from "./src/terminal/sidebar/register.ts";
import { registerAgents } from "./src/core/subagents/register.ts";
import type { BackendName } from "./src/core/subagents/domain.ts";

/** Where child sessions run. The legacy out-of-process launcher is retired. */
export type SubagentRuntimeMode = "pi-cli" | "host-worker";
import {
  createPiSessionWorkContextStore,
  type WorkContextStore,
} from "./src/work-context/persistence.ts";

export interface PiTaiRuntime {
  mode: SubagentRuntimeMode;
  config: PiTaiConfigService;
  workContext: WorkContextStore;
  titleGenerator: TitleGenerator;
  queryTerminalBackground: QueryTerminalBackground;
  notificationSender: NotificationSender;
  capabilities: SessionCapabilityController;
  agentDir: string;
  rootSessionId?: string;
  /** Opt-in subagent backends beyond the built-in pi one. */
  backends?: readonly BackendName[];
  /** Harness used for subagents when a spawn names none. */
  defaultBackend?: BackendName;
}

export type PiTaiRegistrar = (pi: ExtensionAPI, runtime: PiTaiRuntime) => void | Promise<void>;

export interface PiTaiRegistrars {
  keybindings: PiTaiRegistrar;
  config: PiTaiRegistrar;
  compaction: PiTaiRegistrar;
  capabilities: PiTaiRegistrar;
  workContext: PiTaiRegistrar;
  contextTransfer: PiTaiRegistrar;
  responseEditor: PiTaiRegistrar;
  modelProfiles: PiTaiRegistrar;
  subagents: PiTaiRegistrar;
  sessionTitle: PiTaiRegistrar;
  sidebar: PiTaiRegistrar;
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
  contextTransfer: (pi, runtime) => registerContextTransfer(pi, runtime.agentDir),
  responseEditor: (pi) => {
    registerResponseEditor(pi);
  },
  modelProfiles: (pi, runtime) => {
    registerModelProfiles(pi, runtime.config);
  },
  subagents: (pi, runtime) => {
    registerAgents(pi, {
      config: runtime.config,
      agentDir: runtime.agentDir,
      ...(runtime.backends ? { backends: runtime.backends } : {}),
      ...(runtime.defaultBackend ? { defaultBackend: runtime.defaultBackend } : {}),
    });
  },
  sessionTitle: (pi, runtime) => {
    registerSessionTitle(pi, runtime.config, runtime.titleGenerator);
  },
  sidebar: (pi) => registerBtw(pi),
  cmux: async (pi, runtime) => {
    await registerCmux(pi, runtime.config);
  },
  notifications: (pi, runtime) => {
    registerNotifications(pi, runtime.config, runtime.notificationSender);
  },
  guardian: (pi, runtime) =>
    registerApprovalGuardian(pi, {
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
    await registrars.contextTransfer(pi, runtime);
    await registrars.responseEditor(pi, runtime);
    await registrars.modelProfiles(pi, runtime);
    await registrars.subagents(pi, runtime);
    await registrars.sessionTitle(pi, runtime);
    await registrars.sidebar(pi, runtime);
    await registrars.cmux(pi, runtime);
    await registrars.notifications(pi, runtime);
    await registrars.guardian(pi, runtime);
    await registrars.footer(pi, runtime);
    await registrars.ansiTheme(pi, runtime);
  };
}

export default createPiTaiExtension();
