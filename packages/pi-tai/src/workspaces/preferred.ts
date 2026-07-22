import type {
  WorkspaceAbandonResult,
  WorkspaceAttachment,
  WorkspaceAvailability,
  WorkspaceCreateRequest,
  WorkspaceIntegrationResult,
  WorkspacePort,
  WorkspaceTip,
} from "./domain.ts";

export class PreferredWorkspacePort implements WorkspacePort {
  readonly kind = "preferred" as const;
  private readonly jj: WorkspacePort;
  private readonly git: WorkspacePort;

  constructor(jj: WorkspacePort, git: WorkspacePort) {
    this.jj = jj;
    this.git = git;
  }

  async select(cwd: string): Promise<WorkspacePort> {
    const jj = await this.jj.probe(cwd);
    if (jj.available) return this.jj;
    const git = await this.git.probe(cwd);
    if (git.available) return this.git;
    throw new Error(`No workspace backend is available. JJ: ${jj.reason ?? "unavailable"}; Git: ${git.reason ?? "unavailable"}.`);
  }

  async probe(cwd: string): Promise<WorkspaceAvailability> {
    try {
      const selected = await this.select(cwd);
      return selected.probe(cwd);
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async create(request: WorkspaceCreateRequest): Promise<WorkspaceAttachment> {
    const selected = await this.select(request.cwd);
    // Selection is complete before mutation. A create failure never retries through the other backend.
    return selected.create(request);
  }

  captureTip(workspace: WorkspaceAttachment): Promise<WorkspaceTip> {
    return this.backend(workspace).captureTip(workspace);
  }

  integrate(workspace: WorkspaceAttachment): Promise<WorkspaceIntegrationResult> {
    return this.backend(workspace).integrate(workspace);
  }

  finalize(workspace: WorkspaceAttachment): Promise<void> {
    return this.backend(workspace).finalize(workspace);
  }

  abandon(workspace: WorkspaceAttachment): Promise<WorkspaceAbandonResult> {
    return this.backend(workspace).abandon(workspace);
  }

  private backend(workspace: WorkspaceAttachment): WorkspacePort {
    return workspace.backend === "jj" ? this.jj : this.git;
  }
}
