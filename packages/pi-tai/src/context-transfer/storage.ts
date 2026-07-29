import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseContextTransferArtifact, type ContextTransferArtifact } from "./domain.ts";

export interface ContextTransferStore {
  save(artifact: ContextTransferArtifact): Promise<void>;
  load(id: string): Promise<ContextTransferArtifact>;
}

export function createFileContextTransferStore(agentDir: string): ContextTransferStore {
  const directory = join(agentDir, "context-transfers");
  const pathFor = (id: string) => {
    if (!/^[a-z0-9][a-z0-9-]{5,63}$/i.test(id)) throw new Error("Invalid context-transfer ID.");
    return join(directory, `${id}.json`);
  };
  return {
    async save(artifact) {
      const validated = parseContextTransferArtifact(artifact);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const destination = pathFor(validated.id);
      const temporary = `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(validated)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporary, destination);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    },
    async load(id) {
      const artifact = parseContextTransferArtifact(JSON.parse(await readFile(pathFor(id.trim()), "utf8")));
      if (artifact.id !== id.trim()) throw new Error("Context-transfer artifact ID does not match.");
      return artifact;
    },
  };
}
