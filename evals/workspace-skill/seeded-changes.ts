import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type SeededEntry = {
  path: string;
  contentHash: string;
  revision: "committed" | "working-copy";
  state: "tracked" | "untracked" | "staged" | "unstaged";
  preservation: "unchanged" | "absent-from-sibling" | "source-content-excluded";
};

export type SeedManifest = {
  seed: string;
  historyLength: number;
  revisions: string[];
  entries: SeededEntry[];
  auxiliary: Array<{
    path: string;
    contentHash: string;
    state: "delegated-working-copy" | "dirty-linked-worktree";
    preservation: "recoverable";
  }>;
};

export function deriveSeed(root: string, caseId: string, trial: number): string {
  return createHash("sha256").update(`${root}\0${caseId}\0${trial}`).digest("hex").slice(0, 16);
}

export function stableCommitTimestamp(seed: string, index: number): string {
  const offset = Number.parseInt(seed.slice(0, 8), 16) % (365 * 24 * 60 * 60);
  return `${946684800 + offset + index} +0000`;
}

function random(seed: string): () => number {
  let state = Number.parseInt(seed.slice(0, 8), 16) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

export function contentHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function put(repo: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), content);
}

export async function seedCommittedFiles(repo: string, seed: string): Promise<SeedManifest> {
  const rand = random(seed);
  const historyLength = 2 + Math.floor(rand() * 3);
  const paths = [
    `src/generated/${Math.floor(rand() * 1000)}/router-map.txt`,
    `config/nested/eval-${Math.floor(rand() * 1000)}.json`,
    `notes/history/${Math.floor(rand() * 1000)}/topology.md`,
  ];
  const entries: SeededEntry[] = [];
  for (const path of paths) {
    const content = `${path}\nseed=${seed}\nvalue=${Math.floor(rand() * 1e9)}\n`;
    await put(repo, path, content);
    entries.push({
      path,
      contentHash: contentHash(content),
      revision: "committed",
      state: "tracked",
      preservation: "unchanged",
    });
  }
  return { seed, historyLength, revisions: [], entries, auxiliary: [] };
}

export async function seedDirtyFiles(
  repo: string,
  seed: string,
  backend: "jj" | "git",
): Promise<SeededEntry[]> {
  const rand = random(seed);
  const entries: SeededEntry[] = [];
  const untracked = `scratch/nested/${Math.floor(rand() * 1e6)}/untracked.txt`;
  const untrackedContent = `untracked ${seed}\n`;
  await put(repo, untracked, untrackedContent);
  entries.push({
    path: untracked,
    contentHash: contentHash(untrackedContent),
    revision: "working-copy",
    state: "untracked",
    preservation: "absent-from-sibling",
  });
  if (backend === "git") {
    const staged = `scratch/staged-${Math.floor(rand() * 1e6)}.txt`;
    const content = `staged ${seed}\n`;
    await put(repo, staged, content);
    entries.push({
      path: staged,
      contentHash: contentHash(content),
      revision: "working-copy",
      state: "staged",
      preservation: "absent-from-sibling",
    });
  }
  return entries;
}

export async function verifyManifest(repo: string, manifest: SeedManifest): Promise<string[]> {
  const errors: string[] = [];
  for (const entry of manifest.entries) {
    try {
      const body = await readFile(join(repo, entry.path));
      if (contentHash(body) !== entry.contentHash) errors.push(`${entry.path}: content changed`);
    } catch {
      errors.push(`${entry.path}: missing`);
    }
  }
  for (const entry of manifest.auxiliary) {
    try {
      const body = await readFile(entry.path);
      if (contentHash(body) !== entry.contentHash) errors.push(`${entry.path}: recovery content changed`);
    } catch {
      errors.push(`${entry.path}: recovery path missing`);
    }
  }
  return errors;
}
