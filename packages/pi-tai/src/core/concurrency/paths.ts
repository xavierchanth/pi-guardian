import { dirname, join, resolve } from "node:path";

/**
 * Filesystem layout for a child session's private state.
 *
 * Each child gets its own directory so sessions cannot read each other's
 * transcripts, and the id is validated because it reaches the filesystem.
 */
export interface PrivateContextPaths {
  readonly root: string;
  readonly sessions: string;
  readonly artifacts: string;
}

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function privateContextPaths(stateRoot: string, contextId: string): PrivateContextPaths {
  if (!ID_PATTERN.test(contextId)) throw new Error(`Unsafe context id: ${contextId}`);
  const contextsRoot = resolve(stateRoot, "contexts");
  const root = resolve(contextsRoot, contextId);
  // Belt and braces against a traversal that slipped past the pattern.
  if (dirname(root) !== contextsRoot)
    throw new Error("Private context path escaped its managed root.");
  return { root, sessions: join(root, "sessions"), artifacts: join(root, "artifacts") };
}
