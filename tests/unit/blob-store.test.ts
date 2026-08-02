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
import { PrivateBlobStore } from "../../packages/pi-tai/src/core/artifacts/blob-store.ts";
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
  assert.throws(() => store.publishUtf8("opaque/report.v1", "replacement"));

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
    /Unsafe artifact directory/,
  );

  const fresh = new PrivateBlobStore({ rootSessionId: "root_3", paths });
  fresh.publishUtf8("linked", "body");
  const record = join(fresh.root, readdirSync(fresh.root)[0]);
  chmodSync(record, 0o700);
  rmSync(join(record, "body"));
  symlinkSync(join(record, "metadata.json"), join(record, "body"));
  chmodSync(record, 0o500);
  assert.throws(() => fresh.readBinary("linked"), /Unsafe artifact file/);
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
