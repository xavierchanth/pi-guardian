import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerAnsiTheme from "./src/ansi-theme/index.ts";
import {
  createPiTaiConfigService,
  registerPiTaiConfig,
  type PiTaiConfigService,
} from "./src/config/register.ts";
import registerModes from "./src/modes/index.ts";
import registerTaskContext from "./src/task-context/index.ts";

export interface PiTaiRuntime {
  config: PiTaiConfigService;
}

export type PiTaiRegistrar = (
  pi: ExtensionAPI,
  runtime: PiTaiRuntime,
) => void | Promise<void>;

export interface PiTaiRegistrars {
  config: PiTaiRegistrar;
  taskContext: PiTaiRegistrar;
  modes: PiTaiRegistrar;
  ansiTheme: PiTaiRegistrar;
}

const productionRegistrars: PiTaiRegistrars = {
  config: (pi, runtime) => registerPiTaiConfig(pi, runtime.config),
  taskContext: (pi) => registerTaskContext(pi),
  modes: (pi) => registerModes(pi),
  ansiTheme: (pi) => registerAnsiTheme(pi),
};

function createProductionRuntime(): PiTaiRuntime {
  return { config: createPiTaiConfigService() };
}

export function createPiTaiExtension(
  registrars: PiTaiRegistrars = productionRegistrars,
  createRuntime: () => PiTaiRuntime = createProductionRuntime,
): (pi: ExtensionAPI) => Promise<void> {
  return async (pi) => {
    const runtime = createRuntime();
    await registrars.config(pi, runtime);
    await registrars.taskContext(pi, runtime);
    await registrars.modes(pi, runtime);
    await registrars.ansiTheme(pi, runtime);
  };
}

export default createPiTaiExtension();
