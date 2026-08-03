import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CustodyEvidence,
  CustodyReconciler,
  decideCustody,
  type HeadEvidence,
  type RepositoryGrade,
} from "../../packages/pi-tai/src/core/isolation/custody-reconciler.ts";
import type {
  BeginOperationInput,
  CustodyDisposition,
  CustodyMutation,
  CustodyRecord,
  WorkspaceCustodyPort,
} from "../../packages/pi-tai/src/core/isolation/custody-port.ts";
import { openDurableDatabase } from "../../packages/pi-tai/src/core/storage/sqlite.ts";
import { resolveStoragePaths } from "../../packages/pi-tai/src/core/storage/paths.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dispositions: CustodyDisposition[] = [
  "attached",
  "detached",
  "missing",
  "merged",
  "abandoned",
  "incident",
];
const record = (disposition: CustodyDisposition = "attached"): CustodyRecord => ({
  id: "w",
  name: "w",
  path: "/repo/w",
  repoId: "r",
  repoRoot: "/repo",
  disposition,
  attachmentEvidence: "present",
  directoryEvidence: "present",
  evidenceAt: "2026-01-01",
  baseChangeIds: ["base"],
  rootChangeId: "root",
  headChangeIds: ["old"],
  conflictRetained: false,
  rootSessionId: "s",
  quarantined: false,
  attention: false,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
});
const baseline: CustodyEvidence = {
  repository: "same",
  attachment: "present",
  directory: "present",
  heads: { kind: "unique", changeId: "head" },
  target: "not_ancestor",
};

test("K5a ordered rows classify every distinct evidence outcome", () => {
  const rows: Array<[string, Partial<CustodyEvidence>, CustodyDisposition, string, boolean?]> = [
    ["visible receipt", { abandonReceipt: true }, "incident", "ambiguity"],
    [
      "hidden receipt",
      { abandonReceipt: true, heads: { kind: "hidden" } },
      "abandoned",
      "abandon_receipted",
    ],
    ["unavailable", { repository: "unknown" }, "attached", "heads_refreshed", false],
    ["foreign", { repository: "foreign" }, "incident", "ambiguity"],
    [
      "divergent",
      { heads: { kind: "divergent", changeIds: ["z", "a", "z"] } },
      "incident",
      "ambiguity",
    ],
    ["hidden", { heads: { kind: "hidden", changeIds: ["z", "a"] } }, "incident", "ambiguity"],
    ["merge", { mergeReceipt: true, target: "ancestor" }, "merged", "merge_proved"],
    ["conflict", { target: "conflicted" }, "attached", "merge_conflicts_retained"],
    ["relocated", { repository: "relocated" }, "attached", "repo_rebound"],
    ["attached", {}, "attached", "heads_refreshed"],
    ["detached heads", { attachment: "absent" }, "detached", "evidence_missing"],
    ["deleted heads", { directory: "absent" }, "detached", "evidence_missing"],
    ["forgotten", { attachment: "absent", heads: { kind: "absent" } }, "detached", "forget"],
    [
      "missing",
      { attachment: "absent", directory: "absent", heads: { kind: "absent" } },
      "missing",
      "evidence_missing",
    ],
    ["contradiction", { directory: "absent", heads: { kind: "absent" } }, "incident", "ambiguity"],
  ];
  for (const [name, patch, disposition, cause, mutate = true] of rows) {
    const decision = decideCustody(record(), { ...baseline, ...patch });
    assert.equal(decision.disposition, disposition, name);
    assert.equal(decision.cause, cause, name);
    assert.equal(decision.mutate, mutate, name);
  }
});

test("K5a exhaustively returns a closed decision for the full evidence product", () => {
  const repositories: RepositoryGrade[] = ["same", "relocated", "foreign", "unknown"];
  const grades = ["present", "absent", "unknown"] as const;
  const heads: HeadEvidence[] = [
    { kind: "unique", changeId: "head" },
    { kind: "absent" },
    { kind: "divergent", changeIds: ["b", "a", "b"] },
    { kind: "hidden" },
    { kind: "unknown" },
  ];
  const targets = [undefined, "ancestor", "not_ancestor", "conflicted", "unknown"] as const;
  let cases = 0;
  for (const disposition of dispositions)
    for (const repository of repositories)
      for (const attachment of grades)
        for (const directory of grades)
          for (const head of heads)
            for (const target of targets)
              for (const mergeReceipt of [false, true])
                for (const abandonReceipt of [false, true]) {
                  const decision = decideCustody(record(disposition), {
                    repository,
                    attachment,
                    directory,
                    heads: head,
                    target,
                    mergeReceipt,
                    abandonReceipt,
                  });
                  assert.ok(dispositions.includes(decision.disposition));
                  assert.ok(decision.reason.length > 0);
                  assert.deepEqual(decision.heads, [...new Set(decision.heads)].sort());
                  if (
                    repository === "unknown" ||
                    attachment === "unknown" ||
                    directory === "unknown" ||
                    head.kind === "unknown" ||
                    target === "unknown"
                  ) {
                    assert.equal(decision.mutate, false);
                    assert.equal(decision.disposition, disposition);
                    assert.deepEqual(decision.heads, ["old"]);
                  }
                  cases++;
                }
  assert.equal(cases, 21_600);
});

test("receipt ordering rejects unavailable, foreign, and visible evidence", () => {
  for (const patch of [
    { repository: "unknown" as const },
    { heads: { kind: "unknown" as const } },
  ]) {
    const decision = decideCustody(record(), { ...baseline, ...patch, abandonReceipt: true });
    assert.equal(decision.mutate, false);
    assert.equal(decision.disposition, "attached");
  }
  const foreign = decideCustody(record(), {
    ...baseline,
    repository: "foreign",
    abandonReceipt: true,
  });
  assert.equal(foreign.disposition, "incident");
  assert.equal(foreign.reason, "foreign repository");

  const visible = decideCustody(record(), { ...baseline, abandonReceipt: true });
  assert.equal(visible.disposition, "incident");
  assert.equal(visible.reason, "abandon_contradicted");

  for (const heads of [{ kind: "hidden" as const }, { kind: "absent" as const }]) {
    const stable = decideCustody(record(), { ...baseline, heads, abandonReceipt: true });
    assert.equal(stable.disposition, "abandoned");
    assert.equal(stable.cause, "abandon_receipted");
  }
});

test("K5a decisions with mutations name schema-legal transitions in a real database", () => {
  const home = mkdtempSync(join(tmpdir(), "custody-k5a-schema-"));
  const db = openDurableDatabase({ paths: resolveStoragePaths({}, home) });
  const variants: CustodyEvidence[] = [
    baseline,
    { ...baseline, repository: "foreign" },
    { ...baseline, heads: { kind: "hidden" } },
    { ...baseline, heads: { kind: "absent" }, attachment: "absent", directory: "absent" },
    { ...baseline, heads: { kind: "hidden" }, abandonReceipt: true },
    { ...baseline, mergeReceipt: true, target: "ancestor" },
  ];
  for (const from of dispositions) {
    for (const evidence of variants) {
      const decision = decideCustody(record(from), evidence);
      if (!decision.mutate) continue;
      const legal = db
        .prepare(
          "SELECT 1 ok FROM allowed_custody_transition WHERE from_disposition=? AND to_disposition=? AND cause=?",
        )
        .get(from, decision.disposition, decision.cause);
      assert.ok(legal, `${from} -> ${decision.disposition} (${decision.cause})`);
    }
  }
  db.close();
});

test("CustodyReconciler writes once, is idempotent, and skips mutate-false evidence", async () => {
  const calls: Array<{ input?: BeginOperationInput; mutation?: CustodyMutation }> = [];
  let current = record();
  const port = {
    async begin(input: BeginOperationInput) {
      calls.push({ input });
      return { ...input, state: "intent" as const };
    },
    async commit(_opId: string, mutation: CustodyMutation) {
      calls.push({ mutation });
      current = {
        ...current,
        ...mutation.patch,
        disposition: mutation.disposition ?? current.disposition,
        updatedAt: mutation.now,
      };
      return current;
    },
  } as unknown as WorkspaceCustodyPort;
  const reconciler = new CustodyReconciler(port, {
    rootSessionId: "s",
    pid: 7,
    processIdentity: "process",
  });

  const detached = { ...baseline, attachment: "absent" as const };
  const written = await reconciler.reconcile(current, detached, "2026-01-02");
  assert.equal(written.disposition, "detached");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.input?.requestedBy, "system_reconcile");
  assert.equal(calls[1]?.mutation?.cause, "evidence_missing");

  assert.equal(await reconciler.reconcile(written, detached, "2026-01-03"), written);
  assert.equal(calls.length, 2);

  const unavailable = { ...detached, repository: "unknown" as const };
  assert.equal(await reconciler.reconcile(written, unavailable, "2026-01-04"), written);
  assert.equal(calls.length, 2);
});
