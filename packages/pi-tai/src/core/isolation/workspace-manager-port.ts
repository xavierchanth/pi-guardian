import type {
  ChangeEntry,
  MergeResult,
  MergeStrategy,
  SweepEntry,
  WorkspaceId,
  WorkspaceRecord,
} from "./domain.ts";
import type { CreateWorkspaceInput } from "./manager.ts";

/** API consumed by subagent isolation; implementations may use file or SQLite custody. */
export interface WorkspaceManagerPort {
  create(input?: CreateWorkspaceInput): Promise<WorkspaceRecord>;
  get(id: WorkspaceId): Promise<WorkspaceRecord | undefined>;
  list(): Promise<WorkspaceRecord[]>;
  pendingChanges(id: WorkspaceId): Promise<ChangeEntry[] | undefined>;
  assignOwner(id: WorkspaceId, ownerId: string, ownerDisplayId?: string): Promise<void>;
  merge(id: WorkspaceId, strategy?: MergeStrategy): Promise<MergeResult>;
  discard(id: WorkspaceId): Promise<{ discardedChangeIds: readonly string[] }>;
  sweep(activeOwners?: readonly string[]): Promise<SweepEntry[]>;
}
