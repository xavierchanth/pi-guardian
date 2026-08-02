import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

test("fresh staging cleanup claims observe the real-time grace period", () => {
  const { store } = fixture();
  const claim = join(store.root, `.tmp-320-${"a".repeat(32)}.cleanup-${"b".repeat(32)}`);
  mkdirSync(claim, { mode: 0o700 });
  writeFileSync(join(claim, "body"), "still claimed", { mode: 0o600 });

  assert.equal(
    store.cleanupStaging({
      olderThanMs: MIN_STAGING_AGE_MS,
      now: Date.now() + MIN_STAGING_AGE_MS + 1000,
    }),
    0,
  );
  assert.equal(existsSync(claim), true);
});

test("concurrent staging cleaners tolerate lost per-entry races and converge", async () => {
  const { paths, store } = fixture();
  const eligibleEntries = 96;
  for (let index = 0; index < eligibleEntries; index++) {
    const staging = join(store.root, `.tmp-321-${index.toString(16).padStart(32, "0")}`);
    mkdirSync(staging, { mode: 0o700 });
    writeFileSync(join(staging, "body"), Buffer.alloc(4096, index), { mode: 0o600 });
    writeFileSync(join(staging, "metadata.json"), JSON.stringify({ index }), { mode: 0o600 });
  }

  const moduleUrl = pathToFileURL(
    join(process.cwd(), "packages/pi-tai/src/core/artifacts/blob-store.ts"),
  ).href;
  const source = `
    const { PrivateBlobStore, MIN_STAGING_AGE_MS } = await import(process.env.MODULE_URL);
    const paths = JSON.parse(process.env.STORAGE_PATHS);
    process.stdout.write("READY\\n");
    await new Promise((resolve) => process.stdin.once("data", resolve));
    process.stdin.destroy();
    const store = new PrivateBlobStore({ rootSessionId: "root_1", paths });
    const count = store.cleanupStaging({
      maxEntries: ${eligibleEntries},
      olderThanMs: MIN_STAGING_AGE_MS,
      now: Date.now() + MIN_STAGING_AGE_MS + 1000,
    });
    process.stdout.write("RESULT:" + count + "\\n");
  `;
  const workers = Array.from({ length: 4 }, () => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      env: { ...process.env, MODULE_URL: moduleUrl, STORAGE_PATHS: JSON.stringify(paths) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const diagnostics = () =>
      `exit=${child.exitCode} signal=${child.signalCode} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`cleaner readiness timed out: ${diagnostics()}`)),
        5000,
      );
      const finish = (error?: Error) => {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.off("error", onError);
        child.off("close", onClose);
        error ? reject(error) : resolve();
      };
      const onData = () => stdout.includes("READY\n") && finish();
      const onError = (error: Error) => finish(error);
      const onClose = () => finish(new Error(`cleaner closed before ready: ${diagnostics()}`));
      child.stdout.on("data", onData);
      child.once("error", onError);
      child.once("close", onClose);
    });
    const result = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        const match = stdout.match(/RESULT:(\d+)\n/);
        if (code === 0 && match) resolve(Number(match[1]));
        else reject(new Error(`cleaner failed: ${diagnostics()}`));
      });
    });
    return { child, ready, result };
  });

  try {
    await Promise.all(workers.map((worker) => worker.ready));
    workers.forEach(({ child }) => {
      child.stdin.end("go\n");
    });
    const counts = await Promise.all(workers.map((worker) => worker.result));
    assert.equal(
      counts.reduce((sum, count) => sum + count, 0),
      eligibleEntries,
    );
    assert.equal(
      readdirSync(store.root).some((name) => /^\.tmp-321-/.test(name)),
      false,
    );
  } finally {
    for (const { child } of workers) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.allSettled(workers.map((worker) => worker.result));
  }
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
