export type WorkspaceBackendKind = "jj" | "git";
export type WorkspacePurpose = "relocation" | "delegation";

export interface JjWorkspaceAttachment {
  backend: "jj";
  purpose: WorkspacePurpose;
  repoRoot: string;
  sourceWorkspace: string;
  baseChangeId: string;
  name: string;
  path: string;
  rootChangeId: string;
}

export interface GitWorkspaceAttachment {
  backend: "git";
  purpose: WorkspacePurpose;
  repoRoot: string;
  sourceWorktree: string;
  baseCommit: string;
  branch: string;
  name: string;
  path: string;
}

export type WorkspaceAttachment = JjWorkspaceAttachment | GitWorkspaceAttachment;

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
  clean: boolean;
}

export interface WorkspaceIntegrationResult {
  conflicted: boolean;
  conflictFiles: string[];
}

export interface WorkspaceAbandonResult {
  removed: boolean;
  recoveryPath?: string;
}

export interface WorkspacePort {
  readonly kind: WorkspaceBackendKind | "preferred";
  probe(cwd: string): Promise<WorkspaceAvailability>;
  create(request: WorkspaceCreateRequest): Promise<WorkspaceAttachment>;
  captureTip(workspace: WorkspaceAttachment): Promise<WorkspaceTip>;
  integrate(workspace: WorkspaceAttachment): Promise<WorkspaceIntegrationResult>;
  finalize(workspace: WorkspaceAttachment): Promise<void>;
  abandon(workspace: WorkspaceAttachment): Promise<WorkspaceAbandonResult>;
}

export function requireJjWorkspace(workspace: WorkspaceAttachment): JjWorkspaceAttachment {
  if (workspace.backend !== "jj") throw new Error(`Expected JJ workspace, received ${workspace.backend}.`);
  return workspace;
}

export function requireGitWorkspace(workspace: WorkspaceAttachment): GitWorkspaceAttachment {
  if (workspace.backend !== "git") throw new Error(`Expected Git worktree, received ${workspace.backend}.`);
  return workspace;
}
