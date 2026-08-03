import assert from "node:assert/strict";
import test from "node:test";
import {
  dashboardBodyCapacity,
  ensureVisible,
  moveSelection,
  reconcileSelection,
} from "../../packages/pi-tai/src/core/dashboard/viewport.ts";

const ids = Array.from({ length: 100 }, (_, index) => `id-${index}`);

test("viewport is bounded and always contains selection", () => {
  for (let rows = 0; rows < 80; rows++) {
    for (let selected = 0; selected < ids.length; selected++) {
      const capacity = dashboardBodyCapacity(rows);
      const view = ensureVisible(ids, ids[selected], capacity, selected - 20);
      assert.ok(view.end - view.start <= capacity);
      assert.ok(view.end <= ids.length);
      if (capacity > 0) assert.ok(selected >= view.start && selected < view.end);
    }
  }
});

test("selection follows identity through reorder and falls back near a removed row", () => {
  assert.equal(reconcileSelection(["c", "a", "b"], "b", 1), "b");
  assert.equal(reconcileSelection(["a", "c"], "b", 1), "c");
  assert.equal(reconcileSelection([], "b", 1), undefined);
  assert.equal(moveSelection(["a", "b", "c"], "b", 1), "c");
});

test("resize preserves identity and minimally adjusts scroll", () => {
  const narrow = ensureVisible(ids, "id-50", 5, 0);
  const wide = ensureVisible(ids, "id-50", 20, narrow.start);
  assert.equal(ids[50], "id-50");
  assert.ok(50 >= wide.start && 50 < wide.end);
  assert.ok(wide.start <= narrow.start);
});
