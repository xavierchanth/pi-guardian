import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerAnsiTheme from "./src/ansi-theme/index.ts";
import registerModes from "./src/modes/index.ts";
import registerTaskContext from "./src/task-context/index.ts";

export type PiTaiRegistrar = (pi: ExtensionAPI) => void | Promise<void>;

export interface PiTaiRegistrars {
  taskContext: PiTaiRegistrar;
  modes: PiTaiRegistrar;
  ansiTheme: PiTaiRegistrar;
}

const productionRegistrars: PiTaiRegistrars = {
  taskContext: registerTaskContext,
  modes: registerModes,
  ansiTheme: registerAnsiTheme,
};

export function createPiTaiExtension(
  registrars: PiTaiRegistrars = productionRegistrars,
): PiTaiRegistrar {
  return async (pi) => {
    await registrars.taskContext(pi);
    await registrars.modes(pi);
    await registrars.ansiTheme(pi);
  };
}

export default createPiTaiExtension();
