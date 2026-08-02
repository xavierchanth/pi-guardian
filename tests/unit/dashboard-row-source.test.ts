import assert from "node:assert/strict";
import test from "node:test";
import {
  KeysetHydrator,
  type RowSource,
} from "../../packages/pi-tai/src/core/dashboard/row-source.ts";

test("async hydration drops stale results by sequence", async () => {
  const releases: Array<(value: { rows: number[]; next?: string }) => void> = [];
  const source: RowSource<number> = {
    load: () => new Promise((resolve) => releases.push(resolve)),
  };
  const rows = new KeysetHydrator(source, 2, 4);
  const first = rows.hydrate();
  const second = rows.hydrate();
  releases[1]!({ rows: [2], next: "two" });
  await second;
  releases[0]!({ rows: [1] });
  assert.equal(await first, false);
  assert.deepEqual(rows.snapshot().rows, [2]);
});

test("dispose invalidates in-flight hydration and silences observers", async () => {
  let release!: (value: { rows: number[] }) => void;
  const rows = new KeysetHydrator<number>({
    load: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  let changes = 0;
  rows.subscribe(() => changes++);
  const pending = rows.hydrate();
  assert.equal(changes, 1);
  rows.dispose();
  release({ rows: [1] });
  assert.equal(await pending, false);
  assert.deepEqual(rows.snapshot().rows, []);
  assert.equal(changes, 1);
});

test("keyset prefetch appends and trims its bounded cache", async () => {
  let page = 0;
  const source: RowSource<number> = {
    async load() {
      page++;
      return { rows: [page * 2 - 1, page * 2], next: page < 3 ? String(page) : undefined };
    },
  };
  const rows = new KeysetHydrator(source, 2, 4);
  await rows.hydrate();
  await rows.prefetchNext();
  await rows.prefetchNext();
  assert.deepEqual(rows.snapshot().rows, [3, 4, 5, 6]);
  assert.equal(rows.snapshot().loading, false);
});
