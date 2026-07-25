import { join } from "node:path";
import { FileReviewStore, ReviewService, type ReviewStore } from "../concurrency/reviews.ts";
import { FileTaskStore, TaskService, type TaskStore } from "../concurrency/tasks.ts";
import { workspaceId } from "./domain.ts";
import { JjProcessExecutor, type JjExecutor } from "./executor.ts";
import { IsolatedJjOperations } from "./isolated-operations.ts";
import { SharedJjRuntime } from "./runtime.ts";
import { WorkspaceArtifactStore } from "./workspace-artifacts.ts";
import { FileIsolatedWorkspaceStore, type IsolatedWorkspaceStore } from "./workspace-persistence.ts";
import { WorkspaceClosureService } from "./workspace-closure.ts";
import { WorkspaceConflictService } from "./workspace-conflicts.ts";
import { WorkspaceIntegrationService } from "./workspace-integration.ts";
import { JjWorkspaceRepositoryKernel } from "./workspace-repository.ts";
import { WorkspaceReviewCoordinator } from "./workspace-review.ts";
import { WorkspaceRecoveryInspector, WorkspaceRecoveryPlanner } from "./workspace-recovery.ts";
import { WorkspaceFileSetCoordinator } from "./workspace-file-sets.ts";
import { WorkspaceFileCheckpointer } from "./workspace-file-checkpoint.ts";

export class IsolatedJjRuntime {
  readonly shared: SharedJjRuntime;
  readonly workspaces: IsolatedWorkspaceStore;
  readonly repository: JjWorkspaceRepositoryKernel;
  readonly artifacts: WorkspaceArtifactStore;
  readonly tasks: TaskService;
  readonly reviews: ReviewService;
  readonly reviewCoordinator: WorkspaceReviewCoordinator;
  readonly integration: WorkspaceIntegrationService;
  readonly closure: WorkspaceClosureService;
  readonly conflicts: WorkspaceConflictService;
  readonly operations: IsolatedJjOperations;
  readonly recoveryInspector: WorkspaceRecoveryInspector;
  readonly recoveryPlanner: WorkspaceRecoveryPlanner;
  readonly workspaceFileSets: WorkspaceFileSetCoordinator;
  readonly workspaceFileCheckpointer: WorkspaceFileCheckpointer;
  private initialization?: Promise<void>;
  constructor(options: { stateRoot: string; executor?: JjExecutor; workspaces?: IsolatedWorkspaceStore; taskStore?: TaskStore; reviewStore?: ReviewStore; shared?: SharedJjRuntime; failpoint?: (operation: string, boundary: string) => void }) {
    const executor = options.executor ?? new JjProcessExecutor();
    this.shared = options.shared ?? new SharedJjRuntime({ stateRoot: options.stateRoot, executor });
    this.workspaces = options.workspaces ?? new FileIsolatedWorkspaceStore(join(options.stateRoot, "jj-workspaces"));
    this.repository = new JjWorkspaceRepositoryKernel({ executor, workspaces: this.workspaces, sources: this.shared.store });
    this.artifacts = new WorkspaceArtifactStore(join(options.stateRoot, "workspace-artifacts"));
    this.tasks = new TaskService(options.taskStore ?? new FileTaskStore(join(options.stateRoot, "tasks")), join(options.stateRoot, "task-artifacts"));
    this.reviews = new ReviewService(options.reviewStore ?? new FileReviewStore(join(options.stateRoot, "reviews")));
    this.reviewCoordinator = new WorkspaceReviewCoordinator(this.workspaces, this.reviews, this.tasks);
    this.integration = new WorkspaceIntegrationService({ workspaces: this.workspaces, reviews: this.reviews, sources: this.shared.kernel, repository: this.repository, ...(options.failpoint ? { failpoint: options.failpoint } : {}) });
    this.closure = new WorkspaceClosureService(this.workspaces, this.shared.kernel, this.integration);
    this.conflicts = new WorkspaceConflictService(this.workspaces, this.shared.kernel);
    this.operations = new IsolatedJjOperations({ sources: this.shared.kernel, workspaces: this.workspaces, repository: this.repository, artifacts: this.artifacts, executor, ...(options.failpoint ? { failpoint: options.failpoint } : {}) });
    this.recoveryInspector = new WorkspaceRecoveryInspector(this.workspaces, this.repository);
    this.recoveryPlanner = new WorkspaceRecoveryPlanner();
    this.workspaceFileSets = new WorkspaceFileSetCoordinator({ workspaces: this.workspaces, repository: this.repository });
    this.workspaceFileCheckpointer = new WorkspaceFileCheckpointer({ workspaces: this.workspaces, repository: this.repository, fileSets: this.workspaceFileSets });
  }
  initialize(): Promise<void> {
    if (!this.initialization) this.initialization = this.workspaces.list().then(async (records) => {
      for (const record of records) {
        if (record.phase === "incident" && record.lastSafePhase === "allocating") await this.operations.reconcileAllocation(workspaceId(record.workspaceId));
        if (record.phase === "active") {
          await this.workspaces.interruptLiveClaims(record.identity.workspaceId, "process restart");
          if (record.writer.phase !== "available" && record.writer.phase !== "interrupted") await this.workspaces.interruptLiveWriters(record.identity.workspaceId, "process restart");
          await this.operations.reconcileInterrupted(workspaceId(record.identity.workspaceId));
        }
      }
    });
    return this.initialization;
  }
}
