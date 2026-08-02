import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PrivateXdgRoots {
  root: string;
  env: NodeJS.ProcessEnv;
  remove(): void;
}

/** Creates all XDG roots up front so runtime tests never fall back to the test runner's user paths. */
export function createPrivateXdgRoots(prefix = "pi-tai-runtime-xdg-"): PrivateXdgRoots {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const env: NodeJS.ProcessEnv = {
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
  };
  for (const path of Object.values(env)) mkdirSync(path as string, { recursive: true, mode: 0o700 });
  return {
    root,
    env,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}
