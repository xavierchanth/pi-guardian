import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerAnsiTheme from "./src/ansi-theme/index.ts";
import {
  createPiTaiConfigService,
  registerPiTaiConfig,
  type PiTaiConfigService,
} from "./src/config/register.ts";
import registerModes from "./src/modes/index.ts";
import { registerWorkContext } from "./src/work-context/register.ts";
import {
  createPiSessionWorkContextStore,
  type WorkContextStore,
} from "./src/work-context/persistence.ts";

export interface PiTaiRuntime {
  config: PiTaiConfigService;
  workContext: WorkContextStore;
}

export type PiTaiRegistrar = (
  pi: ExtensionAPI,
  runtime: PiTaiRuntime,
) => void | Promise<void>;

export interface PiTaiRegistrars {
  config: PiTaiRegistrar;
  workContext: PiTaiRegistrar;
  modes: PiTaiRegistrar;
  ansiTheme: PiTaiRegistrar;
}

const productionRegistrars: PiTaiRegistrars = {
  config: (pi, runtime) => registerPiTaiConfig(pi, runtime.config),
  workContext: (pi, runtime) => {
    registerWorkContext(pi, runtime.workContext);
  },
  modes: (pi) => registerModes(pi),
  ansiTheme: (pi) => registerAnsiTheme(pi),
};

function createProductionRuntime(): PiTaiRuntime {
  return {
    config: createPiTaiConfigService(),
    workContext: createPiSessionWorkContextStore(),
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
    await registrars.modes(pi, runtime);
    await registrars.ansiTheme(pi, runtime);
  };
}

export default createPiTaiExtension();
