import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { queryTerminalBackground, type QueryTerminalBackground } from "./src/ansi-theme/query.ts";
import { registerAnsiTheme } from "./src/ansi-theme/register.ts";
import {
  createPiTaiConfigService,
  registerPiTaiConfig,
  type PiTaiConfigService,
} from "./src/config/register.ts";
import { registerApprovalGuardian } from "./src/guardian/register.ts";
import {
  registerNotifications,
  sendNativeTerminalNotification,
  type NotificationSender,
} from "./src/notifications/index.ts";
import { generateModelTitle, type TitleGenerator } from "./src/session-title/generate.ts";
import { registerSessionTitle } from "./src/session-title/register.ts";
import { registerSubagents } from "./src/subagents/register.ts";
import { registerWorkContext } from "./src/work-context/register.ts";
import {
  createPiSessionWorkContextStore,
  type WorkContextStore,
} from "./src/work-context/persistence.ts";

export interface PiTaiRuntime {
  config: PiTaiConfigService;
  workContext: WorkContextStore;
  titleGenerator: TitleGenerator;
  queryTerminalBackground: QueryTerminalBackground;
  notificationSender: NotificationSender;
}

export type PiTaiRegistrar = (
  pi: ExtensionAPI,
  runtime: PiTaiRuntime,
) => void | Promise<void>;

export interface PiTaiRegistrars {
  config: PiTaiRegistrar;
  workContext: PiTaiRegistrar;
  subagents: PiTaiRegistrar;
  sessionTitle: PiTaiRegistrar;
  notifications: PiTaiRegistrar;
  guardian: PiTaiRegistrar;
  ansiTheme: PiTaiRegistrar;
}

const productionRegistrars: PiTaiRegistrars = {
  config: (pi, runtime) => registerPiTaiConfig(pi, runtime.config),
  workContext: (pi, runtime) => {
    registerWorkContext(pi, runtime.workContext);
  },
  subagents: (pi) => {
    registerSubagents(pi);
  },
  sessionTitle: (pi, runtime) => {
    registerSessionTitle(pi, runtime.config, runtime.titleGenerator);
  },
  notifications: (pi, runtime) => {
    registerNotifications(pi, runtime.config, runtime.notificationSender);
  },
  guardian: (pi, runtime) => registerApprovalGuardian(pi, {
    workContext: () => runtime.workContext.current(),
  }),
  ansiTheme: (pi, runtime) => {
    registerAnsiTheme(pi, runtime.config, runtime.queryTerminalBackground);
  },
};

function createProductionRuntime(): PiTaiRuntime {
  return {
    config: createPiTaiConfigService(),
    workContext: createPiSessionWorkContextStore(),
    titleGenerator: generateModelTitle,
    queryTerminalBackground,
    notificationSender: sendNativeTerminalNotification,
  };
}

export function createPiTaiExtension(
  registrars: PiTaiRegistrars = productionRegistrars,
  createRuntime: () => PiTaiRuntime = createProductionRuntime,
): (pi: ExtensionAPI) => Promise<void> {
  return async (pi) => {
    const runtime = createRuntime();
    await registrars.config(pi, runtime);
    await registrars.workContext(pi, runtime);
    await registrars.subagents(pi, runtime);
    await registrars.sessionTitle(pi, runtime);
    await registrars.notifications(pi, runtime);
    await registrars.guardian(pi, runtime);
    await registrars.ansiTheme(pi, runtime);
  };
}

export default createPiTaiExtension();
