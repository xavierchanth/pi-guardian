import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CustodyEvidenceCollector,
  CustodyReconciliationService,
  repositoryStoreKey,
} from "../../packages/pi-tai/src/core/isolation/custody-evidence.ts";

test("K5b storeKey is populated from a colocated Git store", async () => {
  const root = mkdtempSync(join(tmpdir(), "pitai-store-key-"));
  mkdirSync(join(root, ".git"));
  assert.equal(await repositoryStoreKey(root), realpathSync(join(root, ".git")));
});

test("K5b hook facade keeps dashboard SQLite-only, throttles, forces, and reports dropped diagnostics", async () => {
  const rows = ["a", "b", "c"].map((id) => ({ id, updatedAt: "before" }));
  const port = {
    list: async () => rows,
    get: async (id: string) => rows.find((row) => row.id === id),
  };
  let calls = 0;
  const collector = {
    collect: async () => {
      calls++;
      throw new Error("JJ unavailable");
    },
  };
  const reconciler = {
    reconcile: async () => {
      throw new Error("unreachable");
    },
  };
  const service = new CustodyReconciliationService(
    port as any,
    collector as any,
    reconciler as any,
    1,
    60_000,
  );

  assert.equal((await service.dashboard()).examined, 3);
  assert.equal(calls, 0, "dashboard must issue zero JJ calls");
  const first = await service.reload();
  assert.equal(first.diagnostics.length, 1);
  assert.equal(first.droppedDiagnostics, 2);
  assert.equal(calls, 3);
  assert.equal((await service.status()).examined, 0, "ordinary hooks are throttled");
  await service.preOperation();
  await service.postOperation();
  assert.equal(calls, 9, "force hooks bypass throttling");
});

// Importing the concrete collector here protects its public direct-test facade.
test("K5b collector is directly constructible", () => {
  assert.ok(new CustodyEvidenceCollector({} as any, {} as any));
});
