export {
  isSettled,
  type ChangeEntry,
  type MergeResult,
  type MergeStrategy,
  type MergeSummary,
  type SweepEntry,
  type WorkspaceId,
  type WorkspacePhase,
  type WorkspaceRecord,
} from "./domain.ts";
export { exact, exactAny, JjCli } from "./jj.ts";
export {
  MANAGED_WORKSPACE_PREFIX,
  WorkspaceManager,
  type CreateWorkspaceInput,
  type WorkspaceManagerOptions,
} from "./manager.ts";
export {
  FileWorkspaceRegistry,
  InMemoryWorkspaceRegistry,
  type WorkspaceRegistryPort,
} from "./registry.ts";
