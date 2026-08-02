import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  ArtifactStoreError,
  MIN_STAGING_AGE_MS,
  PrivateBlobStore,
} from "../../packages/pi-tai/src/core/artifacts/blob-store.ts";
import { resolveStoragePaths } from "../../packages/pi-tai/src/core/storage/paths.ts";

function fixture(maxBlobBytes = 1024) {
  const home = mkdtempSync(join(tmpdir(), "pi-tai-blobs-"));
  const paths = resolveStoragePaths({}, home);
  const store = new PrivateBlobStore({ rootSessionId: "root_1", paths, maxBlobBytes });
  return { home, paths, store };
}

test("private blob store atomically publishes immutable UTF-8 and binary records", () => {
  const { store } = fixture();
  const receipt = store.publishUtf8("opaque/report.v1", "# bytes only\n");
  assert.equal(store.readUtf8("opaque/report.v1", receipt.digest), "# bytes only\n");
  assert.deepEqual([...store.readBinary("opaque/report.v1")], [...Buffer.from("# bytes only\n")]);
  assert.equal(store.publishUtf8("opaque/report.v1", "# bytes only\n").outcome, "already-present");
  assert.throws(() => store.publishUtf8("opaque/report.v1", "replacement"), /different content/);

  const record = readdirSync(store.root).find((name) => !name.startsWith(".tmp-"));
  assert.ok(record);
  assert.equal(statSync(join(store.root, record)).mode & 0o777, 0o500);
  assert.deepEqual(
    readdirSync(store.root).filter((name) => name.startsWith(".tmp-")),
    [],
  );
});

test("keys, root sessions, bounds, Unicode, and digest claims fail closed", () => {
  const { store, paths } = fixture(4);
  for (const key of ["", "/absolute", "../escape", "a/../b", "a//b", "a\\b"])
    assert.throws(() => store.publishBinary(key, new Uint8Array()));
  assert.throws(() => new PrivateBlobStore({ rootSessionId: "../other", paths }));
  assert.throws(() => store.publishBinary("five", Buffer.from("12345")), /bound/);
  assert.throws(() => store.publishUtf8("unicode", "\ud800"), /Unicode/);
  assert.throws(() => store.publishUtf8("digest", "x", "0".repeat(64)), /digest mismatch/);
});

test("partitions are private and root and record symlinks are never followed", () => {
  const { home, paths, store } = fixture();
  store.publishUtf8("one", "secret");
  assert.equal(store.root.startsWith(paths.data), true);
  assert.equal(store.root.startsWith(paths.runtime), false);
  assert.notEqual(new PrivateBlobStore({ rootSessionId: "root_2", paths }).root, store.root);

  const unsafePaths = resolveStoragePaths({}, join(home, "unsafe"));
  mkdirSync(unsafePaths.data, { recursive: true, mode: 0o700 });
  const unsafeArtifacts = join(unsafePaths.data, "artifacts");
  symlinkSync(home, unsafeArtifacts);
  assert.throws(
    () => new PrivateBlobStore({ rootSessionId: "root_bad", paths: unsafePaths }),
    /storage operation failed/,
  );

  const fresh = new PrivateBlobStore({ rootSessionId: "root_3", paths });
  fresh.publishUtf8("linked", "body");
  const record = join(fresh.root, readdirSync(fresh.root)[0]);
  chmodSync(record, 0o700);
  rmSync(join(record, "body"));
  symlinkSync(join(record, "metadata.json"), join(record, "body"));
  chmodSync(record, 0o500);
  assert.throws(() => fresh.readBinary("linked"), /storage operation failed/);
});

test("session ids normalize and staging cleanup enforces age and a strict bound", () => {
  const { paths } = fixture();
  const lower = new PrivateBlobStore({ rootSessionId: "root_case", paths });
  const upper = new PrivateBlobStore({ rootSessionId: "ROOT_CASE", paths });
  assert.equal(lower.root, upper.root);
  for (const suffix of ["1", "2", "3"]) {
    const staging = join(lower.root, `.tmp-123-${suffix.repeat(32)}`);
    mkdirSync(staging, { mode: 0o700 });
  }
  mkdirSync(join(lower.root, ".tmp-not-owned"), { mode: 0o700 });
  assert.throws(
    () => lower.cleanupStaging({ olderThanMs: 0 }),
    (error: ArtifactStoreError) => error.code === "invalid-input",
  );
  const now = Date.now() + MIN_STAGING_AGE_MS + 1000;
  assert.equal(lower.cleanupStaging({ maxEntries: 2, olderThanMs: MIN_STAGING_AGE_MS, now }), 2);
  assert.equal(readdirSync(lower.root).filter((name) => /^\.tmp-123-/.test(name)).length, 1);
  assert.equal(lower.cleanupStaging({ maxEntries: 2, olderThanMs: MIN_STAGING_AGE_MS, now }), 1);
  assert.equal(existsSync(join(lower.root, ".tmp-not-owned")), true);
});

test("concurrent staging cleaners tolerate lost per-entry races and converge", async () => {
  const { paths, store } = fixture();
  for (let index = 0; index < 64; index++)
    mkdirSync(join(store.root, `.tmp-321-${index.toString(16).padStart(32, "0")}`), {
      mode: 0o700,
    });

  const barrier = new SharedArrayBuffer(4);
  const moduleUrl = pathToFileURL(
    join(process.cwd(), "packages/pi-tai/src/core/artifacts/blob-store.ts"),
  ).href;
  const source = `
    import { parentPort, workerData } from "node:worker_threads";
    const { PrivateBlobStore, MIN_STAGING_AGE_MS } = await import(workerData.moduleUrl);
    const gate = new Int32Array(workerData.barrier);
    parentPort.postMessage("ready");
    Atomics.wait(gate, 0, 0);
    const store = new PrivateBlobStore({ rootSessionId: "root_1", paths: workerData.paths });
    parentPort.postMessage(store.cleanupStaging({
      maxEntries: 64,
      olderThanMs: MIN_STAGING_AGE_MS,
      now: Date.now() + MIN_STAGING_AGE_MS + 1000,
    }));
  `;
  const workers = [0, 1].map(
    () => new Worker(source, { eval: true, workerData: { barrier, moduleUrl, paths } }),
  );
  await Promise.all(
    workers.map((worker) => new Promise((resolve) => worker.once("message", resolve))),
  );
  Atomics.store(new Int32Array(barrier), 0, 1);
  Atomics.notify(new Int32Array(barrier), 0, workers.length);
  const counts = await Promise.all(
    workers.map(
      (worker) =>
        new Promise<number>((resolve, reject) => {
          worker.once("message", resolve);
          worker.once("error", reject);
        }),
    ),
  );
  assert.equal(
    counts.every((count) => count <= 64),
    true,
  );
  assert.equal(
    readdirSync(store.root).some((name) => /^\.tmp-321-/.test(name)),
    false,
  );
});

test("missing records have a typed path-private error", () => {
  const { store, home } = fixture();
  assert.throws(
    () => store.readBinary("absent"),
    (error: ArtifactStoreError) => {
      assert.equal(error.code, "not-found");
      assert.equal(error.message.includes(home), false);
      return true;
    },
  );
});

test("mode drift is rejected without leaking absolute paths", () => {
  const { store, home } = fixture();
  store.publishUtf8("mode", "body");
  chmodSync(store.root, 0o755);
  assert.throws(
    () => store.readUtf8("mode"),
    (error: Error) => {
      assert.equal(error.message.includes(home), false);
      return true;
    },
  );
});

test("corruption and interrupted temporary records are not observable", () => {
  const { store } = fixture();
  const receipt = store.publishBinary("bytes", Buffer.from([0, 1, 2]));
  const record = join(store.root, readdirSync(store.root)[0]);
  chmodSync(record, 0o700);
  chmodSync(join(record, "body"), 0o600);
  writeFileSync(join(record, "body"), Buffer.from([3, 4, 5]));
  chmodSync(join(record, "body"), 0o400);
  chmodSync(record, 0o500);
  assert.throws(() => store.readBinary("bytes", receipt.digest), /digest mismatch/);

  const crash = join(store.root, ".tmp-crashed");
  // A crash before rename leaves no addressable key and cannot shadow a publish.
  mkdirSync(crash, { mode: 0o700 });
  assert.equal(existsSync(crash), true);
  assert.throws(() => store.readBinary("never-published"));
  store.publishUtf8("after-crash", "ok");
  assert.equal(store.readUtf8("after-crash"), "ok");
});
