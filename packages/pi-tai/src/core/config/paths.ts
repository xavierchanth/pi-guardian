import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const PI_TAI_CONFIG_FILE = "pi-tai.json";

export function piTaiConfigPaths(cwd: string, agentDir = getAgentDir()) {
  return {
    global: join(agentDir, PI_TAI_CONFIG_FILE),
    project: join(cwd, CONFIG_DIR_NAME, PI_TAI_CONFIG_FILE),
  };
}
