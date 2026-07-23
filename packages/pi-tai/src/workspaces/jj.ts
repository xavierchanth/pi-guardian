import { JjWorkspaceService, runJjCommand } from "./jj-service.ts";
import {
  requireJjWorkspace,
  type WorkspaceAbandonResult,
  type WorkspaceAttachment,
  type WorkspaceAvailability,
  type WorkspaceCreateRequest,
  type WorkspaceIntegrationResult,
  type WorkspacePort,
  type WorkspaceTip,
} from "./domain.ts";

export class JjWorkspacePort implements WorkspacePort {
  readonly kind = "jj" as const;
  private readonly service: JjWorkspaceService;

  constructor(service: JjWorkspaceService = new JjWorkspaceService()) {
    this.service = service;
  }

  async probe(cwd: string): Promise<WorkspaceAvailability> {
    try {
      const repoRoot = (await runJjCommand(cwd, ["root"])).trim();
      return repoRoot ? { available: true, repoRoot } : { available: false, reason: "Unable to resolve JJ repository root." };
    } catch {
      return { available: false, reason: "The cwd is not a JJ repository or jj is unavailable." };
    }
  }

  async create(request: WorkspaceCreateRequest): Promise<WorkspaceAttachment> {
    const created = request.purpose === "delegation"
      ? await this.service.createChildWorkspace(request.cwd, request.name)
      : await this.service.createRelocationWorkspace(request.cwd, request.name);
    return {
      backend: "jj",
      purpose: request.purpose,
      repoRoot: created.repoRoot,
      sourceWorkspace: created.parentWorkspace,
      baseChangeId: created.baseChangeId,
      name: created.childWorkspace,
      path: created.childWorkspacePath,
      rootChangeId: created.childRootChangeId,
    };
  }

  async captureTip(workspace: WorkspaceAttachment): Promise<WorkspaceTip> {
    const jj = requireJjWorkspace(workspace);
    return { id: await this.service.currentChangeId(jj.path), clean: true };
  }

  async integrate(workspace: WorkspaceAttachment): Promise<WorkspaceIntegrationResult> {
    const jj = requireJjWorkspace(workspace);
    return this.service.integrateChildWorkspace({
      repoRoot: jj.repoRoot,
      parentWorkspace: jj.sourceWorkspace,
      childWorkspace: jj.name,
      childWorkspacePath: jj.path,
      childRootChangeId: jj.rootChangeId,
    });
  }

  async finalize(workspace: WorkspaceAttachment): Promise<void> {
    const jj = requireJjWorkspace(workspace);
    await this.service.finalizeChildWorkspace({
      repoRoot: jj.repoRoot,
      parentWorkspace: jj.sourceWorkspace,
      childWorkspace: jj.name,
      childWorkspacePath: jj.path,
    });
  }

  async abandon(workspace: WorkspaceAttachment): Promise<WorkspaceAbandonResult> {
    const jj = requireJjWorkspace(workspace);
    await this.service.abandonChildWorkspace({
      repoRoot: jj.repoRoot,
      childWorkspace: jj.name,
      childWorkspacePath: jj.path,
    });
    return { removed: true };
  }
}
