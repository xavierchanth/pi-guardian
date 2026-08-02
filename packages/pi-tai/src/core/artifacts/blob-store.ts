import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { resolveStoragePaths, type StoragePaths } from "../storage/paths.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ROOT_SESSION = /^[A-Za-z0-9_-]{1,128}$/;
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
}

interface BlobMetadata {
  version: 1;
  algorithm: "sha256";
  digest: string;
  bytes: number;
}

/**
 * Private, immutable storage for opaque blobs. This class deliberately has no
 * report, image, task, or Markdown knowledge.
 */
export class PrivateBlobStore {
  readonly root: string;
  readonly maxBlobBytes: number;

  constructor(options: BlobStoreOptions) {
    if (!ROOT_SESSION.test(options.rootSessionId)) throw new Error("Invalid root session id");
    if (
      options.maxBlobBytes !== undefined &&
      (!Number.isSafeInteger(options.maxBlobBytes) || options.maxBlobBytes < 1)
    )
      throw new Error("Invalid blob size bound");
    this.maxBlobBytes = options.maxBlobBytes ?? 16 * 1024 * 1024;
    const paths = options.paths ?? resolveStoragePaths();
    this.root = join(paths.data, "artifacts", "sessions", options.rootSessionId, "blobs");
    this.ensureRoot(paths.data);
  }

  publishBinary(key: string, body: Uint8Array, expectedDigest?: string): BlobReceipt {
    validateKey(key);
    if (body.byteLength > this.maxBlobBytes) throw new Error("Blob exceeds size bound");
    if (expectedDigest !== undefined && !SHA256.test(expectedDigest))
      throw new Error("Invalid expected digest");
    this.assertSafeRoot();
    const bytes = Buffer.from(body);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (expectedDigest !== undefined && digest !== expectedDigest)
      throw new Error("Blob digest mismatch");

    const destination = this.recordPath(key);
    const temporary = join(this.root, `.tmp-${process.pid}-${randomBytes(16).toString("hex")}`);
    mkdirSync(temporary, { mode: 0o700 });
    try {
      writePrivateDurable(join(temporary, "body"), bytes);
      const metadata: BlobMetadata = { version: 1, algorithm: "sha256", digest, bytes: bytes.length };
      writePrivateDurable(join(temporary, "metadata.json"), Buffer.from(JSON.stringify(metadata)));
      chmodSync(join(temporary, "body"), 0o400);
      chmodSync(join(temporary, "metadata.json"), 0o400);
      fsyncDirectory(temporary);
      chmodSync(temporary, 0o500);
      // Recheck immediately before the atomic commit. rename does not replace a
      // populated directory, so concurrent publication fails rather than overwrites.
      this.assertSafeRoot();
      renameSync(temporary, destination);
      fsyncDirectory(this.root);
      return { key, digest, bytes: bytes.length };
    } catch (error) {
      // Publication may already have made the staging record read-only.
      try {
        chmodSync(temporary, 0o700);
      } catch {}
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  publishUtf8(key: string, body: string, expectedDigest?: string): BlobReceipt {
    if (hasUnpairedSurrogate(body)) throw new Error("Body is not valid Unicode");
    return this.publishBinary(key, Buffer.from(body, "utf8"), expectedDigest);
  }

  readBinary(key: string, expectedDigest?: string): Uint8Array {
    validateKey(key);
    if (expectedDigest !== undefined && !SHA256.test(expectedDigest))
      throw new Error("Invalid expected digest");
    this.assertSafeRoot();
    const record = this.recordPath(key);
    assertPrivateDirectory(record, 0o500);
    const metadata = readMetadata(join(record, "metadata.json"), this.maxBlobBytes);
    if (expectedDigest !== undefined && metadata.digest !== expectedDigest)
      throw new Error("Blob digest mismatch");
    const body = readPrivateFile(join(record, "body"), this.maxBlobBytes);
    if (body.length !== metadata.bytes) throw new Error("Blob size mismatch");
    const actual = createHash("sha256").update(body).digest("hex");
    if (actual !== metadata.digest) throw new Error("Blob digest mismatch");
    return new Uint8Array(body);
  }

  readUtf8(key: string, expectedDigest?: string): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.readBinary(key, expectedDigest));
  }

  private recordPath(key: string): string {
    // Hashing maps an opaque key into one flat component: callers gain no path authority.
    return join(this.root, createHash("sha256").update(key).digest("hex"));
  }

  private ensureRoot(dataRoot: string): void {
    // XDG's conventional parent directories need not exist on first use. They
    // are not artifact authority; the centralized pi-tai data root is the
    // boundary we validate and own.
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
    assertPrivateDirectory(dataRoot, 0o700);
    let current = dataRoot;
    for (const component of ["artifacts", "sessions", basename(dirname(this.root)), "blobs"]) {
      current = join(current, component);
      mkdirPrivate(current);
    }
    if (current !== this.root) throw new Error("Artifact root construction failed");
  }

  private assertSafeRoot(): void {
    let current = this.root;
    while (true) {
      assertPrivateDirectory(current, 0o700);
      if (current.endsWith(`${join("pi-tai", "artifacts")}`)) break;
      const parent = dirname(current);
      if (parent === current) throw new Error("Artifact root escaped centralized data root");
      current = parent;
    }
  }
}

function validateKey(key: string): void {
  if (key.length < 1 || key.length > 1024 || isAbsolute(key) || key.includes("\\"))
    throw new Error("Invalid blob key");
  const segments = key.split("/");
  if (segments.length > 16 || segments.some((part) => !KEY_SEGMENT.test(part) || part === "." || part === ".."))
    throw new Error("Invalid blob key");
}

function mkdirPrivate(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  assertPrivateDirectory(path, 0o700);
}

function assertPrivateDirectory(path: string, mode: 0o500 | 0o700): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe artifact directory: ${path}`);
  if ((stat.mode & 0o777) !== mode) throw new Error(`Artifact directory has unsafe mode: ${path}`);
}

function writePrivateDurable(path: string, bytes: Buffer): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readPrivateFile(path: string, bound: number): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o400 || before.nlink !== 1)
    throw new Error(`Unsafe artifact file: ${path}`);
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > bound)
      throw new Error(`Artifact file changed while opening: ${path}`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readMetadata(path: string, bound: number): BlobMetadata {
  const bytes = readPrivateFile(path, 1024);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Invalid blob metadata");
  }
  const m = value as Partial<BlobMetadata>;
  if (
    m.version !== 1 ||
    m.algorithm !== "sha256" ||
    typeof m.digest !== "string" ||
    !SHA256.test(m.digest) ||
    !Number.isSafeInteger(m.bytes) ||
    (m.bytes as number) < 0 ||
    (m.bytes as number) > bound
  )
    throw new Error("Invalid blob metadata");
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
