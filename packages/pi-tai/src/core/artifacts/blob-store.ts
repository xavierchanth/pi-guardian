import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  ensurePrivateDirectory,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  resolveStoragePaths,
  type StoragePaths,
} from "../storage/paths.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ROOT_SESSION = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const STAGING = /^\.tmp-[0-9]+-[0-9a-f]{32}(?:\.cleanup-[0-9a-f]{32})?$/;
const CLAIMED_STAGING = /\.cleanup-[0-9a-f]{32}$/;
/** Prevent cleanup from racing publishers that are still building a staging record. */
export const MIN_STAGING_AGE_MS = 60_000;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export interface BlobStoreOptions {
  /** The custody partition. It is an identifier, never a path. */
  rootSessionId: string;
  paths?: StoragePaths;
  maxBlobBytes?: number;
}

export interface BlobReceipt {
  readonly key: string;
  readonly digest: string;
  readonly bytes: number;
  /** Whether this call committed the record or verified an identical prior commit. */
  readonly outcome: "published" | "already-present";
}

export interface StagingCleanupOptions {
  maxEntries?: number;
  olderThanMs?: number;
  /** Test seam; production callers should omit it. */
  now?: number;
}

interface BlobMetadata {
  version: 1;
  algorithm: "sha256";
  digest: string;
  bytes: number;
  /** Recoverable opaque lookup key; this file remains private and immutable. */
  key: string;
}

export type ArtifactStoreErrorCode =
  | "invalid-input"
  | "not-found"
  | "conflict"
  | "corrupt"
  | "unsafe-storage"
  | "storage-failure";

export class ArtifactStoreError extends Error {
  readonly code: ArtifactStoreErrorCode;

  constructor(code: ArtifactStoreErrorCode, message: string) {
    super(message);
    this.name = "ArtifactStoreError";
    this.code = code;
  }
}

/** Private, immutable storage for opaque blobs. It has no domain-store semantics. */
export class PrivateBlobStore {
  readonly root: string;
  readonly maxBlobBytes: number;
  private readonly dataRoot: string;
  private readonly session: string;

  constructor(options: BlobStoreOptions) {
    const session = options.rootSessionId.toLowerCase();
    if (!ROOT_SESSION.test(session)) throw input("Invalid root session id");
    if (
      options.maxBlobBytes !== undefined &&
      (!Number.isSafeInteger(options.maxBlobBytes) || options.maxBlobBytes < 1)
    )
      throw input("Invalid blob size bound");
    this.maxBlobBytes = options.maxBlobBytes ?? 16 * 1024 * 1024;
    this.session = session;
    const paths = options.paths ?? resolveStoragePaths();
    this.dataRoot = resolve(paths.data);
    this.root = join(this.dataRoot, "artifacts", "sessions", session, "blobs");
    try {
      this.ensureRoot();
    } catch (error) {
      throw publicError(error);
    }
  }

  publishBinary(key: string, body: Uint8Array, expectedDigest?: string): BlobReceipt {
    try {
      validateKey(key);
      if (body.byteLength > this.maxBlobBytes) throw input("Blob exceeds size bound");
      if (expectedDigest !== undefined && !SHA256.test(expectedDigest))
        throw input("Invalid expected digest");
      this.assertSafeRoot();
      const bytes = Buffer.from(body);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (expectedDigest !== undefined && digest !== expectedDigest)
        throw input("Blob digest mismatch");

      const destination = this.recordPath(key);
      const temporary = join(this.root, `.tmp-${process.pid}-${randomBytes(16).toString("hex")}`);
      mkdirSync(temporary, { mode: PRIVATE_DIRECTORY_MODE });
      let renamed = false;
      try {
        writePrivateDurable(join(temporary, "body"), bytes, 0o400);
        const metadata: BlobMetadata = {
          version: 1,
          algorithm: "sha256",
          digest,
          bytes: bytes.length,
          key,
        };
        writePrivateDurable(
          join(temporary, "metadata.json"),
          Buffer.from(JSON.stringify(metadata)),
          0o400,
        );
        chmodSync(temporary, 0o500);
        fsyncDirectory(temporary); // directory mode and entries are durable before publication
        this.assertSafeRoot();
        try {
          renameSync(temporary, destination);
          renamed = true;
        } catch (error) {
          // macOS reports EACCES rather than EEXIST when the immutable (0500)
          // destination directory already exists.
          if (
            !isExists(error) &&
            !((error as NodeJS.ErrnoException).code === "EACCES" && pathExists(destination))
          )
            throw error;
          return this.identicalReceipt(destination, key, digest, bytes.length);
        }
        fsyncDirectory(this.root);
        return { key, digest, bytes: bytes.length, outcome: "published" };
      } finally {
        // If rename succeeded there is no staging path. A parent-fsync failure is
        // intentionally surfaced; retry verifies the committed destination.
        if (!renamed) {
          try {
            chmodSync(temporary, PRIVATE_DIRECTORY_MODE);
          } catch {}
          try {
            rmSync(temporary, { recursive: true, force: true });
          } catch {}
        }
      }
    } catch (error) {
      throw publicError(error);
    }
  }

  publishUtf8(key: string, body: string, expectedDigest?: string): BlobReceipt {
    if (hasUnpairedSurrogate(body)) throw input("Body is not valid Unicode");
    return this.publishBinary(key, Buffer.from(body, "utf8"), expectedDigest);
  }

  readBinary(key: string, expectedDigest?: string): Uint8Array {
    try {
      validateKey(key);
      if (expectedDigest !== undefined && !SHA256.test(expectedDigest))
        throw input("Invalid expected digest");
      this.assertSafeRoot();
      const record = this.recordPath(key);
      try {
        assertPrivateDirectory(record, 0o500);
      } catch (error) {
        if (isMissing(error)) throw notFound();
        throw error;
      }
      const metadata = readMetadata(join(record, "metadata.json"), this.maxBlobBytes);
      if (metadata.key !== key) throw corrupt("Blob key mismatch");
      if (expectedDigest !== undefined && metadata.digest !== expectedDigest)
        throw corrupt("Blob digest mismatch");
      const body = readPrivateFile(join(record, "body"), this.maxBlobBytes);
      if (body.length !== metadata.bytes) throw corrupt("Blob size mismatch");
      if (createHash("sha256").update(body).digest("hex") !== metadata.digest)
        throw corrupt("Blob digest mismatch");
      return new Uint8Array(body);
    } catch (error) {
      throw publicError(error);
    }
  }

  readUtf8(key: string, expectedDigest?: string): string {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(this.readBinary(key, expectedDigest));
    } catch (error) {
      throw publicError(error);
    }
  }

  /**
   * Remove at most maxEntries abandoned staging directories. The minimum age is
   * enforced because zero-age sweeps can delete records from live publishers.
   */
  cleanupStaging(options: StagingCleanupOptions = {}): number {
    try {
      this.assertSafeRoot();
      const max = options.maxEntries ?? 64;
      const age = options.olderThanMs ?? 60 * 60 * 1000;
      const now = options.now ?? Date.now();
      if (
        !Number.isSafeInteger(max) ||
        max < 0 ||
        !Number.isFinite(age) ||
        age < MIN_STAGING_AGE_MS ||
        !Number.isFinite(now)
      )
        throw input("Invalid staging cleanup bound or minimum age");
      let removed = 0;
      for (const name of readdirSync(this.root).sort()) {
        if (removed >= max) break;
        if (!STAGING.test(name)) continue;
        const path = join(this.root, name);
        try {
          const stat = lstatSync(path);
          if (!stat.isDirectory() || stat.isSymbolicLink() || now - stat.mtimeMs < age) continue;
          // A claim's ctime is advanced by rename. Never steal a fresh claim,
          // even when callers inject a future eligibility clock for testing.
          if (CLAIMED_STAGING.test(name) && Date.now() - stat.ctimeMs < MIN_STAGING_AGE_MS)
            continue;

          // Atomically claim the entry before traversing it. This prevents two
          // cleaners from concurrently driving rm's recursive directory walk.
          // Abandoned claims remain recognizable and can be reclaimed later.
          const claim = join(
            this.root,
            `${name.replace(CLAIMED_STAGING, "")}.cleanup-${randomBytes(16).toString("hex")}`,
          );
          renameSync(path, claim);
          const claimedStat = lstatSync(claim);
          if (!claimedStat.isDirectory() || claimedStat.isSymbolicLink())
            throw new Error("Staging entry changed type while being claimed");
          chmodSync(claim, PRIVATE_DIRECTORY_MODE);
          rmSync(claim, { recursive: true });
          removed++;
        } catch (error) {
          // Another cleaner may win the claim or remove a claimed entry first.
          if (isMissing(error)) continue;
          throw error;
        }
      }
      if (removed) fsyncDirectory(this.root);
      return removed;
    } catch (error) {
      throw publicError(error);
    }
  }

  private identicalReceipt(path: string, key: string, digest: string, bytes: number): BlobReceipt {
    try {
      assertPrivateDirectory(path, 0o500);
      const metadata = readMetadata(join(path, "metadata.json"), this.maxBlobBytes);
      if (metadata.key !== key || metadata.digest !== digest || metadata.bytes !== bytes)
        throw new ArtifactStoreError(
          "conflict",
          "Blob key is already published with different content",
        );
      const body = readPrivateFile(join(path, "body"), this.maxBlobBytes);
      if (body.length !== bytes || createHash("sha256").update(body).digest("hex") !== digest)
        throw corrupt("Published blob is corrupt");
      return { key, digest, bytes, outcome: "already-present" };
    } catch (error) {
      throw publicError(error);
    }
  }

  private recordPath(key: string): string {
    return join(this.root, createHash("sha256").update(key).digest("hex"));
  }

  private ensureRoot(): void {
    ensurePrivateDirectory(this.dataRoot);
    let current = this.dataRoot;
    for (const component of ["artifacts", "sessions", this.session, "blobs"]) {
      current = join(current, component);
      mkdirPrivate(current);
    }
    if (resolve(current) !== resolve(this.root))
      throw new Error("Artifact root construction failed");
  }

  private assertSafeRoot(): void {
    const boundary = join(this.dataRoot, "artifacts");
    if (resolve(this.root) !== boundary && !resolve(this.root).startsWith(boundary + sep))
      throw new Error("Artifact root escaped centralized data root");
    let current = this.root;
    while (true) {
      assertPrivateDirectory(current, PRIVATE_DIRECTORY_MODE);
      if (resolve(current) === resolve(boundary)) return;
      const parent = dirname(current);
      if (parent === current) throw new Error("Artifact root escaped centralized data root");
      current = parent;
    }
  }
}

function validateKey(key: string): void {
  if (key.length < 1 || key.length > 1024 || isAbsolute(key) || key.includes("\\"))
    throw input("Invalid blob key");
  const segments = key.split("/");
  if (
    segments.length > 16 ||
    segments.some((part) => !KEY_SEGMENT.test(part) || part === "." || part === "..")
  )
    throw input("Invalid blob key");
}
function mkdirPrivate(path: string): void {
  try {
    mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (!isExists(error)) throw error;
  }
  assertPrivateDirectory(path, PRIVATE_DIRECTORY_MODE);
}
function assertPrivateDirectory(path: string, mode: 0o500 | 0o700): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== mode)
    throw new Error("Unsafe artifact directory");
}
function writePrivateDurable(path: string, bytes: Buffer, finalMode: 0o400): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    writeFileSync(fd, bytes);
    chmodSync(path, finalMode); // persist final mode before syncing file contents/metadata
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function readPrivateFile(path: string, bound: number): Buffer {
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (before.mode & 0o777) !== 0o400 ||
    before.nlink !== 1
  )
    throw new Error("Unsafe artifact file");
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > bound ||
      opened.nlink !== 1
    )
      throw new Error("Artifact file changed while opening");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
function readMetadata(path: string, bound: number): BlobMetadata {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(readPrivateFile(path, 2048)),
    );
  } catch (error) {
    if (error instanceof ArtifactStoreError) throw error;
    throw corrupt("Invalid blob metadata");
  }
  const m = value as Partial<BlobMetadata>;
  if (
    m.version !== 1 ||
    m.algorithm !== "sha256" ||
    typeof m.digest !== "string" ||
    !SHA256.test(m.digest) ||
    typeof m.key !== "string" ||
    !Number.isSafeInteger(m.bytes) ||
    (m.bytes as number) < 0 ||
    (m.bytes as number) > bound
  )
    throw corrupt("Invalid blob metadata");
  return m as BlobMetadata;
}
function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function isExists(error: unknown): boolean {
  return ["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException)?.code ?? "");
}
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
function input(message: string) {
  return new ArtifactStoreError("invalid-input", message);
}
function corrupt(message: string) {
  return new ArtifactStoreError("corrupt", message);
}
function notFound() {
  return new ArtifactStoreError("not-found", "Artifact record not found");
}
function publicError(error: unknown): ArtifactStoreError {
  if (error instanceof ArtifactStoreError) return error;
  return new ArtifactStoreError("storage-failure", "Private artifact storage operation failed");
}
function hasUnpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
