import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  BeginOperationInput,
  CustodyDisposition,
  CustodyRecord,
} from "../../packages/pi-tai/src/core/isolation/custody-port.ts";
import { SqliteWorkspaceCustody } from "../../packages/pi-tai/src/core/isolation/sqlite-custody.ts";
import { openDurableDatabase } from "../../packages/pi-tai/src/core/storage/sqlite.ts";
import { resolveStoragePaths } from "../../packages/pi-tai/src/core/storage/paths.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const now = "2026-01-01T00:00:00.000Z";
function fixture(disposition: CustodyDisposition = "attached") {
  const paths = resolveStoragePaths({}, mkdtempSync(join(tmpdir(), "custody-port-")));
  const db = openDurableDatabase({ paths });
  db.prepare("INSERT INTO pi_session VALUES(?,NULL,NULL,'startup','/',?,?)").run("s", now, now);
  db.prepare("INSERT INTO repository VALUES(?,?,?,?,?,?,?,?)").run(
    "repo",
    "fingerprint",
    0,
    null,
    "/repo",
    1,
    now,
    now,
  );
  const port = new SqliteWorkspaceCustody(db);
  const record: CustodyRecord = {
    id: "w",
    name: "work",
    path: "/repo/work",
    repoId: "repo",
    repoRoot: "/repo",
    disposition,
    attachmentEvidence: "present",
    directoryEvidence: "present",
    evidenceAt: now,
    baseChangeIds: ["kkkk"],
    rootChangeId: "kkkk",
    headChangeIds: ["mmmm", "kkkk", "mmmm"],
    ...(disposition === "merged" ? { mergedIntoChangeId: "nnnn", mergedProofOp: "proof" } : {}),
    ...(disposition === "incident" ? { incident: { stage: "test", reason: "test" } } : {}),
    conflictRetained: false,
    rootSessionId: "s",
    quarantined: false,
    attention: false,
    createdAt: now,
    updatedAt: now,
  };
  const operation = (id: string, kind = "create"): BeginOperationInput => ({
    opId: id,
    workspaceId: "w",
    repoId: "repo",
    kind,
    requestedBy: "user",
    pid: 1,
    processIdentity: "p",
    now,
  });
  return { db, port, record, operation };
}

test("R3 insert and every head patch canonicalize unsorted duplicate Change IDs", async () => {
  const f = fixture();
  assert.deepEqual((await f.port.insert(f.record, f.operation("create"))).headChangeIds, [
    "kkkk",
    "mmmm",
  ]);
  await f.port.begin(f.operation("refresh", "reconcile"));
  const refreshed = await f.port.commit("refresh", {
    workspaceId: "w",
    ownRootSessionId: "s",
    cause: "heads_refreshed",
    patch: { headChangeIds: ["nnnn", "kkkk", "nnnn"] },
    now,
  });
  assert.deepEqual(refreshed.headChangeIds, ["kkkk", "nnnn"]);
  f.db.close();
});

test("R1 merged, abandoned, missing, and incident accept evidence refresh without disposition rewrite", async () => {
  for (const disposition of ["merged", "abandoned", "missing", "incident"] as const) {
    const f = fixture(disposition);
    // Seed terminal rows directly: abandoned insertion is intentionally protected by its receipt trigger.
    if (disposition === "abandoned") {
      f.record = { ...f.record, disposition: "attached" };
    }
    await f.port.insert(f.record, f.operation("create"));
    if (disposition === "abandoned")
      f.db.exec(
        "DROP TRIGGER trg_abandon_requires_receipt_update; DROP TRIGGER trg_workspace_transition; UPDATE workspace SET disposition='abandoned'",
      );
    await f.port.begin(f.operation("refresh", "reconcile"));
    const result = await f.port.commit("refresh", {
      workspaceId: "w",
      ownRootSessionId: "s",
      cause: "heads_refreshed",
      patch: { evidenceAt: "2026-01-02", directoryEvidence: "absent" },
      now: "2026-01-02",
    });
    assert.equal(result.disposition, disposition);
    assert.equal(result.evidenceAt, "2026-01-02");
    f.db.close();
  }
});

test("R1 contradictory identity transition and foreign-root mutation roll back event and operation", async () => {
  const f = fixture();
  await f.port.insert(f.record, f.operation("create"));
  await f.port.begin(f.operation("bad", "reconcile"));
  await assert.rejects(
    f.port.commit("bad", {
      workspaceId: "w",
      ownRootSessionId: "foreign",
      cause: "ambiguity",
      disposition: "incident",
      patch: { incident: { stage: "x", reason: "x" } },
      now,
    }),
  );
  assert.equal(
    (
      f.db.prepare("SELECT state FROM custody_operation WHERE op_id='bad'").get() as {
        state: string;
      }
    ).state,
    "intent",
  );
  assert.equal(
    (f.db.prepare("SELECT count(*) n FROM custody_event WHERE op_id='bad'").get() as { n: number })
      .n,
    0,
  );
  f.db.close();
});
