import { chmodSync, lstatSync, mkdirSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

export interface StoragePaths {
  state: string;
  data: string;
  cache: string;
  runtime: string;
  database: string;
  backups: string;
  quarantine: string;
  migration: string;
  sessions: string;
  workspaces: string;
}

function xdg(value: string | undefined, fallback: string): string {
  return value && isAbsolute(value) ? value : fallback;
}

/** The single resolver for Pi-Tai-owned durable paths. There is intentionally no config override. */
export function resolveStoragePaths(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): StoragePaths {
  const state = join(xdg(env.XDG_STATE_HOME, join(home, ".local", "state")), "pi-tai");
  const data = join(xdg(env.XDG_DATA_HOME, join(home, ".local", "share")), "pi-tai");
  const cache = join(xdg(env.XDG_CACHE_HOME, join(home, ".cache")), "pi-tai");
  // macOS normally has no XDG_RUNTIME_DIR. A private cache child is safer than /tmp.
  const runtime =
    env.XDG_RUNTIME_DIR && isAbsolute(env.XDG_RUNTIME_DIR)
      ? join(env.XDG_RUNTIME_DIR, "pi-tai")
      : join(cache, "run");
  return {
    state,
    data,
    cache,
    runtime,
    database: join(state, "state.sqlite3"),
    backups: join(state, "backups"),
    quarantine: join(state, "quarantine"),
    migration: join(state, "migration"),
    sessions: join(data, "sessions"),
    workspaces: join(data, "workspaces"),
  };
}

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Unsafe storage directory: ${path}`);
  if ((stat.mode & 0o022) !== 0)
    throw new Error(`Storage directory is group- or world-writable: ${path}`);
}

export function ensureStoragePaths(paths: StoragePaths): void {
  for (const path of [
    paths.state,
    paths.data,
    paths.cache,
    paths.runtime,
    paths.backups,
    paths.quarantine,
    paths.migration,
    paths.sessions,
    paths.workspaces,
  ])
    ensurePrivateDirectory(path);
}

/** Resolve an untrusted artifact/session key without permitting traversal or symlink aliases. */
export function privateChild(root: string, ...keys: readonly string[]): string {
  if (keys.some((key) => !/^[A-Za-z0-9_-]+$/.test(key)))
    throw new Error("Invalid storage path key");
  const child = resolve(root, ...keys);
  if (!child.startsWith(resolve(root) + sep)) throw new Error("Storage path escaped its root");
  return child;
}

export type SessionPathKey = string & { readonly __sessionPathKey: unique symbol };
export type ArtifactPathKey = string & { readonly __artifactPathKey: unique symbol };
export function sessionPathKey(value: string): SessionPathKey {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid session path key");
  return value as SessionPathKey;
}
export function artifactPathKey(value: string): ArtifactPathKey {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid artifact path key");
  return value as ArtifactPathKey;
}

export function createPrivateFile(path: string): number {
  const fd = openSync(path, "wx", 0o600);
  chmodSync(path, 0o600);
  return fd;
}
export function closePrivateFile(fd: number): void {
  closeSync(fd);
}
