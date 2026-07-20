import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { queryTerminalBackground, type QueryTerminalBackground } from "./src/ansi-theme/query.ts";
import { registerAnsiTheme } from "./src/ansi-theme/register.ts";
import {
  createPiTaiConfigService,
  registerPiTaiConfig,
  type PiTaiConfigService,
} from "./src/config/register.ts";
import { registerApprovalGuardian } from "./src/guardian/register.ts";
import { generateModelTitle, type TitleGenerator } from "./src/session-title/generate.ts";
import { registerSessionTitle } from "./src/session-title/register.ts";
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
}

export type PiTaiRegistrar = (
  pi: ExtensionAPI,
  runtime: PiTaiRuntime,
) => void | Promise<void>;

export interface PiTaiRegistrars {
  config: PiTaiRegistrar;
  workContext: PiTaiRegistrar;
  sessionTitle: PiTaiRegistrar;
  guardian: PiTaiRegistrar;
  ansiTheme: PiTaiRegistrar;
}

const productionRegistrars: PiTaiRegistrars = {
  config: (pi, runtime) => registerPiTaiConfig(pi, runtime.config),
  workContext: (pi, runtime) => {
    registerWorkContext(pi, runtime.workContext);
  },
  sessionTitle: (pi, runtime) => {
    registerSessionTitle(pi, runtime.config, runtime.titleGenerator);
  },
  guardian: (pi) => registerApprovalGuardian(pi),
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
    await registrars.sessionTitle(pi, runtime);
    await registrars.guardian(pi, runtime);
    await registrars.ansiTheme(pi, runtime);
  };
}

export default createPiTaiExtension();
