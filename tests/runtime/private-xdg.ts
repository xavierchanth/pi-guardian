import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface PrivateXdgEnvironment extends NodeJS.ProcessEnv {
  XDG_STATE_HOME: string;
  XDG_DATA_HOME: string;
  XDG_CACHE_HOME: string;
  XDG_RUNTIME_DIR?: string;
}

export interface PrivateXdgRoots {
  root: string;
  env: PrivateXdgEnvironment;
  remove(): void;
}

/** Isolates durable/cache roots while preserving whether the host supplies a valid runtime root. */
export function createPrivateXdgRoots(
  prefix = "pi-tai-runtime-xdg-",
  parentEnv: NodeJS.ProcessEnv = process.env,
): PrivateXdgRoots {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const env: PrivateXdgEnvironment = {
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
  };
  if (parentEnv.XDG_RUNTIME_DIR && isAbsolute(parentEnv.XDG_RUNTIME_DIR))
    env.XDG_RUNTIME_DIR = join(root, "runtime");
  for (const path of Object.values(env))
    if (path) mkdirSync(path, { recursive: true, mode: 0o700 });
  return {
    root,
    env,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}
