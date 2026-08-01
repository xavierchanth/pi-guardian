import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CustodyEvidence,
  decideCustody,
  type HeadEvidence,
  type RepositoryGrade,
} from "../../packages/pi-tai/src/core/isolation/custody-reconciler.ts";
import type {
  CustodyDisposition,
  CustodyRecord,
} from "../../packages/pi-tai/src/core/isolation/custody-port.ts";

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
    ["receipt", { abandonReceipt: true }, "abandoned", "abandon_receipted"],
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
                    !abandonReceipt &&
                    (repository === "unknown" ||
                      attachment === "unknown" ||
                      directory === "unknown" ||
                      head.kind === "unknown" ||
                      target === "unknown")
                  ) {
                    assert.equal(decision.mutate, false);
                    assert.equal(decision.disposition, disposition);
                    assert.deepEqual(decision.heads, ["old"]);
                  }
                  cases++;
                }
  assert.equal(cases, 21_600);
});
