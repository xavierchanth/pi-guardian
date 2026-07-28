import { join } from "node:path";
import { SharedFileSetCoordinator } from "../concurrency/file-sets.ts";
import type { SourceWorkspaceHandle } from "./domain.ts";
import { JjProcessExecutor, type JjExecutor } from "./executor.ts";
import { FileSharedSourceStore, type SharedSourceStore } from "./persistence.ts";
import { JjRepositoryKernel } from "./repository.ts";
import { createJjBaselineVerifier, DeterministicSharedCheckpointer } from "./shared-checkpoint.ts";
import { SharedJjOperations } from "./shared-operations.ts";

export class SharedJjRuntime {
  readonly store: SharedSourceStore;
  readonly kernel: JjRepositoryKernel;
  readonly operations: SharedJjOperations;
  readonly fileSets: SharedFileSetCoordinator;
  readonly checkpointer: DeterministicSharedCheckpointer;

  constructor(options: { stateRoot: string; executor?: JjExecutor; store?: SharedSourceStore }) {
    this.store = options.store ?? new FileSharedSourceStore(join(options.stateRoot, "jj-sources"));
    this.kernel = new JjRepositoryKernel({ executor: options.executor ?? new JjProcessExecutor(), store: this.store });
    this.operations = new SharedJjOperations({ kernel: this.kernel, store: this.store });
    this.fileSets = new SharedFileSetCoordinator({ store: this.store, verifyBaseline: createJjBaselineVerifier(this.kernel) });
    this.checkpointer = new DeterministicSharedCheckpointer({ kernel: this.kernel, store: this.store, fileSets: this.fileSets });
  }

  async openSource(cwd: string): Promise<SourceWorkspaceHandle> {
    const source = await this.kernel.openSource(cwd);
    await this.fileSets.initialize(source);
    await this.checkpointer.reconcileInterrupted(source);
    return source;
  }
}
