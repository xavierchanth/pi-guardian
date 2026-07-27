import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import type { ClientPreferencesReader } from "../config/register.ts";

const initializedConfigs = new WeakSet<object>();

export interface CmuxRegistrarDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly initI18n?: (pi: ExtensionAPI) => void;
  readonly registerNotify?: (pi: ExtensionAPI) => void;
  readonly registerSidebar?: (pi: ExtensionAPI) => void;
}

export function isCmuxIntegrationActive(
  config: ClientPreferencesReader,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!environment.CMUX_WORKSPACE_ID?.trim() || !initializedConfigs.has(config)) return false;
  try {
    return config.clientPreferences().cmux.enabled;
  } catch {
    return false;
  }
}

export async function registerCmux(
  pi: ExtensionAPI,
  config: ClientPreferencesReader,
  dependencies: CmuxRegistrarDependencies = {},
): Promise<boolean> {
  const environment = dependencies.environment ?? process.env;
  if (!environment.CMUX_WORKSPACE_ID?.trim()) return false;

  const injected = dependencies.initI18n && dependencies.registerNotify && dependencies.registerSidebar;
  if (!injected && !hasCmuxExecutable(environment)) return false;
  const defaults = injected ? undefined : await loadCmuxModules();
  const initializeI18n = dependencies.initI18n ?? defaults!.initI18n;
  const registerNotify = dependencies.registerNotify ?? defaults!.registerNotify;
  const registerSidebar = dependencies.registerSidebar ?? defaults!.registerSidebar;
  const enabled = () => isCmuxIntegrationActive(config, environment);
  const gatedPi = gateEventHandlers(pi, enabled);
  initializeI18n(pi);
  registerNotify(gatedPi);
  registerSidebar(gatedPi);
  initializedConfigs.add(config);
  return true;
}

function hasCmuxExecutable(environment: NodeJS.ProcessEnv): boolean {
  for (const directory of environment.PATH?.split(delimiter) ?? []) {
    if (!directory) continue;
    try {
      accessSync(join(directory, process.platform === "win32" ? "cmux.exe" : "cmux"), constants.X_OK);
      return true;
    } catch {
      // Keep searching the configured executable path.
    }
  }
  return false;
}

async function loadCmuxModules() {
  const jiti = createJiti(import.meta.url, {
    fsCache: false,
    interopDefault: false,
  });
  const [i18n, notify, sidebar] = await Promise.all([
    jiti.import<{ initI18n: (pi: ExtensionAPI) => void }>("pi-cmux/extensions/i18n.ts"),
    jiti.import<{ default: (pi: ExtensionAPI) => void }>("pi-cmux/extensions/cmux-notify.ts"),
    jiti.import<{ default: (pi: ExtensionAPI) => void }>("pi-cmux/extensions/cmux-sidebar.ts"),
  ]);
  return {
    initI18n: i18n.initI18n,
    registerNotify: notify.default,
    registerSidebar: sidebar.default,
  };
}

function gateEventHandlers(pi: ExtensionAPI, enabled: () => boolean): ExtensionAPI {
  type Handler = (event: unknown, context: unknown) => unknown;
  const register = pi.on.bind(pi) as unknown as (name: string, handler: Handler) => void;

  return new Proxy(pi, {
    get(target, property) {
      if (property === "on") {
        return (name: string, handler: Handler) => {
          register(name, (event, context) => enabled() ? handler(event, context) : undefined);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
