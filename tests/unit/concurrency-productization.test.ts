import assert from "node:assert/strict";
import test from "node:test";
import {
  enrollmentPlanDigest,
  sumExactUsage,
  validateConcurrencyTransaction,
  type ConcurrencyProjectionV1,
  type ExactUsageEntryV1,
} from "../../packages/pi-tai/src/core/concurrency/productization.ts";

function projection(revision = 1): ConcurrencyProjectionV1 {
  return {
    version: 1,
    rootSessionId: "root-1",
    revision,
    generatedAt: "2026-01-01T00:00:00Z",
    children: [],
    inactiveChildCount: 0,
    tasks: [],
    inactiveTaskCount: 0,
    workspaces: [],
    activeClaimCount: 0,
    unansweredQuestionCount: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    telemetryGapCount: 0,
    truncated: false,
  };
}

test("concurrency transactions advance one bounded Host-owned revision", () => {
  const transaction = validateConcurrencyTransaction({
    version: 1,
    transactionId: "transaction-1",
    rootSessionId: "root-1",
    runtimeGeneration: 2,
    expectedRevision: 0,
    events: [{ eventId: "event-1", type: "child.created", payload: {} }],
    state: { contexts: [] },
    projection: projection(),
  });
  assert.equal(transaction.projection.revision, 1);
  assert.throws(
    () => validateConcurrencyTransaction({ ...transaction, projection: projection(2) }),
    /advance exactly once/,
  );
  assert.throws(() => validateConcurrencyTransaction({ ...transaction, events: [] }), /1 to 64/);
});

test("enrollment plans are deterministic and exact usage deduplicates semantic events", () => {
  const plan = {
    version: 1 as const,
    planId: "plan-1",
    repositoryPath: "/repo",
    initializationMode: "existing_jj" as const,
    managedWorkspaceRoot: "/repo/.jj/pi-tai/workspaces",
    privateRevsetAlias: "pi_tai_private()" as const,
    privateRevsetExpression: 'description(glob:"pi-tai:*")' as const,
    priorPrivateCommits: "none()",
    nextPrivateCommits: "(none()) | pi_tai_private()",
  };
  assert.equal(enrollmentPlanDigest(plan), enrollmentPlanDigest({ ...plan }));
  const entry: ExactUsageEntryV1 = {
    usageEventId: "usage-1",
    rootSessionId: "root-1",
    contextId: "child-1",
    executionCycleId: "cycle-1",
    messageId: "message-1",
    provider: "provider",
    model: "model",
    role: "worker",
    input: 2,
    output: 3,
    cacheRead: 4,
    cacheWrite: 5,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
    recordedAt: "now",
  };
  assert.deepEqual(sumExactUsage([entry, entry]), {
    input: 2,
    output: 3,
    cacheRead: 4,
    cacheWrite: 5,
    cost: 1,
  });
});
