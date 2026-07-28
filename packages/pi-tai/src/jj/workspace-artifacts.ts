import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const MAX_INLINE_WORKSPACE_EVIDENCE_BYTES = 64 * 1024;
export const MAX_WORKSPACE_ARTIFACT_BYTES = 8 * 1024 * 1024;
export interface WorkspaceArtifactRef { readonly digest: string; readonly bytes: number; readonly mediaType: "application/json" | "text/x-diff"; readonly purpose: string; readonly path: string; }

export class WorkspaceArtifactStore {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  async putJson(workspaceId: string, purpose: string, value: unknown): Promise<WorkspaceArtifactRef> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(workspaceId)) throw new Error("Invalid workspace artifact identity.");
    if (!purpose.trim()) throw new Error("Workspace artifact purpose is required.");
    const content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (content.byteLength > MAX_WORKSPACE_ARTIFACT_BYTES) throw new Error(`Workspace evidence exceeds ${MAX_WORKSPACE_ARTIFACT_BYTES} bytes.`);
    const digest = createHash("sha256").update(content).digest("hex"); const directory = resolve(this.root, workspaceId); if (dirname(directory) !== this.root) throw new Error("Workspace artifact path escaped its managed root.");
    await mkdir(directory, { recursive: true, mode: 0o700 }); const path = join(directory, digest); const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, content, { mode: 0o600, flag: "wx" }); await rename(temporary, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    return { digest, bytes: content.byteLength, mediaType: "application/json", purpose, path };
  }
}
