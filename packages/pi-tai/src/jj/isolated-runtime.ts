import { join } from "node:path";
import { workspaceId } from "./domain.ts";
import { JjProcessExecutor, type JjExecutor } from "./executor.ts";
import { IsolatedJjOperations } from "./isolated-operations.ts";
import { SharedJjRuntime } from "./runtime.ts";
import { WorkspaceArtifactStore } from "./workspace-artifacts.ts";
import { FileIsolatedWorkspaceStore, type IsolatedWorkspaceStore } from "./workspace-persistence.ts";
import { JjWorkspaceRepositoryKernel } from "./workspace-repository.ts";

export class IsolatedJjRuntime {
  readonly shared: SharedJjRuntime;
  readonly workspaces: IsolatedWorkspaceStore;
  readonly repository: JjWorkspaceRepositoryKernel;
  readonly artifacts: WorkspaceArtifactStore;
  readonly operations: IsolatedJjOperations;
  private initialization?: Promise<void>;
  constructor(options: { stateRoot: string; executor?: JjExecutor; workspaces?: IsolatedWorkspaceStore; shared?: SharedJjRuntime; failpoint?: (operation: string, boundary: string) => void }) {
    const executor = options.executor ?? new JjProcessExecutor();
    this.shared = options.shared ?? new SharedJjRuntime({ stateRoot: options.stateRoot, executor });
    this.workspaces = options.workspaces ?? new FileIsolatedWorkspaceStore(join(options.stateRoot, "jj-workspaces"));
    this.repository = new JjWorkspaceRepositoryKernel({ executor, workspaces: this.workspaces, sources: this.shared.store });
    this.artifacts = new WorkspaceArtifactStore(join(options.stateRoot, "workspace-artifacts"));
    this.operations = new IsolatedJjOperations({ sources: this.shared.kernel, workspaces: this.workspaces, repository: this.repository, artifacts: this.artifacts, executor, ...(options.failpoint ? { failpoint: options.failpoint } : {}) });
  }
  initialize(): Promise<void> {
    if (!this.initialization) this.initialization = this.workspaces.list().then(async (records) => {
      for (const record of records) {
        if (record.phase === "incident" && record.lastSafePhase === "allocating") await this.operations.reconcileAllocation(workspaceId(record.workspaceId));
        if (record.phase === "active") {
          if (record.writer.phase !== "available" && record.writer.phase !== "interrupted") await this.workspaces.interruptLiveWriters(record.identity.workspaceId, "process restart");
          await this.operations.reconcileInterrupted(workspaceId(record.identity.workspaceId));
        }
      }
    });
    return this.initialization;
  }
}
