import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type XdgEnvironment,
  xdgEnvironment,
} from "../../packages/pi-tai/src/core/storage/paths.ts";

export interface PrivateXdgRoots {
  root: string;
  env: XdgEnvironment;
  remove(): void;
}

/** Creates all XDG roots up front so runtime tests never fall back to the test runner's user paths. */
export function createPrivateXdgRoots(prefix = "pi-tai-runtime-xdg-"): PrivateXdgRoots {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const env = xdgEnvironment({
    state: join(root, "state"),
    data: join(root, "data"),
    cache: join(root, "cache"),
    runtime: join(root, "runtime"),
  });
  for (const path of Object.values(env)) mkdirSync(path, { recursive: true, mode: 0o700 });
  return {
    root,
    env,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}
