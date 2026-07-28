import assert from "node:assert/strict";
import test from "node:test";
import { DIVERGENT_ARGV, displacedChangeIds, updateStaleSafely } from "../../packages/pi-tai/src/jj/stale-update.ts";

function harness(divergentBefore: string[], divergentAfter: string[], output = "Working copy now at: abc\nAdded 0 files, modified 1 files, removed 1 files\n") {
  const calls: string[][] = [];
  let updated = false;
  return {
    calls,
    context: "Test",
    location: "/tmp/workspace",
    read: async (args: readonly string[]) => { calls.push([...args]); return (updated ? divergentAfter : divergentBefore).join("\n"); },
    run: async (args: readonly string[]) => { calls.push([...args]); updated = true; return output; },
  };
}

test("stale update passes through when nothing was displaced", async () => {
  const io = harness(["aaaa"], ["aaaa"]);
  const outcome = await updateStaleSafely(io);
  assert.deepEqual(outcome.displacedChangeIds, []);
  assert.deepEqual(io.calls[0], [...DIVERGENT_ARGV]);
  assert.deepEqual(io.calls[1], ["workspace", "update-stale"]);
  assert.deepEqual(io.calls[2], [...DIVERGENT_ARGV]);
});

test("stale update refuses to continue when uncommitted work was displaced", async () => {
  const io = harness([], ["kkkk", "zzzz"]);
  await assert.rejects(() => updateStaleSafely(io), (error: Error) => {
    assert.match(error.message, /displaced uncommitted work/);
    assert.match(error.message, /kkkk, zzzz/);
    assert.match(error.message, /\/tmp\/workspace/);
    return true;
  });
});

test("stale update ignores divergent changes that already existed", async () => {
  const outcome = await updateStaleSafely(harness(["kkkk"], ["kkkk"]));
  assert.deepEqual(outcome.displacedChangeIds, []);
});

test("stale update still rejects recovery history", async () => {
  await assert.rejects(
    () => updateStaleSafely(harness([], [], "Created recovery commit for workspace\n")),
    /created recovery history/,
  );
});

test("displaced change IDs are the sorted new arrivals only", () => {
  assert.deepEqual(displacedChangeIds(["b"], ["b", "z", "a"]), ["a", "z"]);
  assert.deepEqual(displacedChangeIds(["a", "b"], ["a", "b"]), []);
  assert.deepEqual(displacedChangeIds([], []), []);
});
