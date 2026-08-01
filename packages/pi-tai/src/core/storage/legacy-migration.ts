import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import type { StoragePaths } from "./paths.ts";
import { ensurePrivateDirectory } from "./paths.ts";

export const LEGACY_CONFIRM_BYTES = 256 * 1024 * 1024;
export interface LegacyCopy {
  source: string;
  destination: string;
  relativePath: string;
  bytes: number;
}
export interface LegacyMigrationPlan {
  sourceRoot: string;
  copies: readonly LegacyCopy[];
  skipped: readonly string[];
  totalBytes: number;
}
export interface LegacyReceipt {
  version: 1;
  sourceRoot: string;
  stateRoot: string;
  dataRoot: string;
  totalBytes: number;
  files: { source: string; destination: string; bytes: number; sha256: string }[];
  skipped: readonly string[];
  quarantined: { source: string; reason: string }[];
  completedAt: string;
}

function walk(
  source: string,
  destination: string,
  prefix: string,
  output: LegacyCopy[],
  skipped: string[],
): void {
  if (!existsSync(source)) return;
  for (const entry of readdirSync(source)) {
    const from = join(source, entry);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) {
      skipped.push(`${relative(prefix, from)} (symlink quarantined)`);
      continue;
    }
    if (stat.isDirectory()) walk(from, join(destination, entry), prefix, output, skipped);
    else if (stat.isFile())
      output.push({
        source: from,
        destination: join(destination, entry),
        relativePath: relative(prefix, from),
        bytes: stat.size,
      });
  }
}

/** Plans only journals/artifacts. Registry, locks, context exports, and managed jj workspaces stay put. */
export function planLegacyMigration(sourceRoot: string, paths: StoragePaths): LegacyMigrationPlan {
  const copies: LegacyCopy[] = [];
  const skipped = [
    join(sourceRoot, "agents", "workspaces"),
    join(sourceRoot, "agents", "workspaces.json"),
    join(sourceRoot, "context-exports"),
  ];
  walk(join(sourceRoot, "agents", "sessions"), paths.sessions, sourceRoot, copies, skipped);
  return {
    sourceRoot,
    copies,
    skipped,
    totalBytes: copies.reduce((n, file) => n + file.bytes, 0),
  };
}
function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function executeLegacyMigration(
  plan: LegacyMigrationPlan,
  paths: StoragePaths,
  options: { confirm?: (plan: LegacyMigrationPlan) => boolean; now?: () => Date } = {},
): LegacyReceipt | undefined {
  if (!existsSync(plan.sourceRoot) || plan.copies.length === 0) return undefined;
  if (plan.totalBytes > LEGACY_CONFIRM_BYTES && !(options.confirm?.(plan) ?? false))
    throw new Error("Legacy migration requires explicit confirmation above 256 MiB");
  const now = options.now?.() ?? new Date();
  const files: LegacyReceipt["files"] = [];
  const quarantined: LegacyReceipt["quarantined"] = [];
  for (const file of plan.copies) {
    const sourceDigest = digest(file.source);
    mkdirSync(dirname(file.destination), { recursive: true, mode: 0o700 });
    if (existsSync(file.destination) && digest(file.destination) !== sourceDigest) {
      quarantined.push({
        source: file.source,
        reason: "destination exists with a different digest",
      });
      continue;
    }
    if (!existsSync(file.destination)) {
      const temporary = `${file.destination}.migrate-${process.pid}`;
      copyFileSync(file.source, temporary);
      const fd = openSync(temporary, "r+");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(temporary, 0o600);
      if (digest(temporary) !== sourceDigest) {
        unlinkSync(temporary);
        quarantined.push({ source: file.source, reason: "copy digest mismatch" });
        continue;
      }
      renameSync(temporary, file.destination);
      fsyncDirectory(dirname(file.destination));
    }
    files.push({
      source: file.source,
      destination: file.destination,
      bytes: file.bytes,
      sha256: sourceDigest,
    });
  }
  ensurePrivateDirectory(paths.migration);
  const stamp = now.toISOString().replaceAll(":", "-");
  const receipt: LegacyReceipt = {
    version: 1,
    sourceRoot: plan.sourceRoot,
    stateRoot: paths.state,
    dataRoot: paths.data,
    totalBytes: plan.totalBytes,
    files,
    skipped: plan.skipped,
    quarantined,
    completedAt: now.toISOString(),
  };
  const receiptPath = join(paths.migration, `${stamp}.json`);
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600, flag: "wx" });
  fsyncDirectory(paths.migration);
  const breadcrumb = join(plan.sourceRoot, "MIGRATED-TO-XDG.txt");
  if (!existsSync(breadcrumb))
    writeFileSync(
      breadcrumb,
      `Pi-Tai data was copied (not moved) to:\nstate: ${paths.state}\ndata: ${paths.data}\nreceipt: ${receiptPath}\nLegacy data was retained.\n`,
      { mode: 0o600, flag: "wx" },
    );
  fsyncDirectory(plan.sourceRoot);
  return receipt;
}
