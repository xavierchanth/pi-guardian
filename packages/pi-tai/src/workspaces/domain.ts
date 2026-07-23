export type WorkspacePurpose = "relocation" | "delegation";

export interface JjWorkspaceAttachment {
  backend: "jj";
  purpose: WorkspacePurpose;
  repoRoot: string;
  sourceWorkspace: string;
  sourcePath: string;
  baseChangeId: string;
  name: string;
  path: string;
  rootChangeId: string;
}

export type WorkspaceAttachment = JjWorkspaceAttachment;

export interface WorkspaceAvailability {
  available: boolean;
  reason?: string;
  repoRoot?: string;
}

export interface WorkspaceCreateRequest {
  cwd: string;
  name: string;
  purpose: WorkspacePurpose;
}

export interface WorkspaceTip {
  id: string;
}

export interface WorkspaceIntegrationResult {
  conflicted: boolean;
  conflictFiles: string[];
  integratedChangeIds: string[];
  undescribedChangeIds: string[];
  removedEmptyChangeIds: string[];
  sourceChangeId: string;
  workspaceRemoved: boolean;
}

export interface WorkspaceChangeDescription {
  changeId: string;
  description: string;
}

export interface WorkspaceAbandonResult {
  removed: boolean;
  recoveryPath?: string;
}

export interface WorkspacePort {
  readonly kind: "jj";
  probe(cwd: string): Promise<WorkspaceAvailability>;
  create(request: WorkspaceCreateRequest): Promise<WorkspaceAttachment>;
  captureTip(workspace: WorkspaceAttachment): Promise<WorkspaceTip>;
  integrate(workspace: WorkspaceAttachment): Promise<WorkspaceIntegrationResult>;
  describe(workspace: WorkspaceAttachment, changes: readonly WorkspaceChangeDescription[]): Promise<string[]>;
  abandon(workspace: WorkspaceAttachment): Promise<WorkspaceAbandonResult>;
}

export function requireJjWorkspace(workspace: WorkspaceAttachment): JjWorkspaceAttachment {
  return workspace;
}
