import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FileRepositoryEnrollmentStore,
  RepositoryEnrollmentService,
} from "../../packages/pi-tai/src/core/jj/repository-enrollment.ts";
import {
  FileSessionWorkspaceStore,
  InMemoryRepositoryLeaseStore,
  RepositoryMutationCoordinator,
  SessionWorkspaceService,
} from "../../packages/pi-tai/src/core/jj/session-workspace.ts";
import { RealJjFixture } from "../support/real-jj-fixture.ts";

test("multiple Host sessions receive independent private workspaces without changing user @", async () => {
  const fixture = await RealJjFixture.create("pi-tai-session-workspace-");
  try {
    await fixture.seed({
      changes: [{ description: "base", files: { "base.txt": "base\n" } }],
      workingCopyFiles: { "user.txt": "user work\n" },
    });
    const userBefore = await fixture.currentChangeId(fixture.repoPath);
    const state = await mkdtemp(join(tmpdir(), "pi-tai-session-state-"));
    try {
      const enrollments = new RepositoryEnrollmentService({
        store: new FileRepositoryEnrollmentStore(join(state, "enrollments")),
        executor: fixture.executor,
      });
      const plan = (await enrollments.plan(fixture.repoPath)).plan;
      const enrollment = await enrollments.enroll(plan, {
        authorizationId: "consent-1",
        planDigest: plan.planDigest,
        authorizedAt: "now",
      });
      const coordinator = new RepositoryMutationCoordinator(new InMemoryRepositoryLeaseStore());
      const workspaces = new SessionWorkspaceService({
        store: new FileSessionWorkspaceStore(join(state, "sessions")),
        coordinator,
        executor: fixture.executor,
      });
      const [first, second] = await Promise.all([
        workspaces.allocate({
          enrollment,
          invokingCwd: fixture.repoPath,
          rootSessionId: "session-1",
          runtimeGeneration: 1,
        }),
        workspaces.allocate({
          enrollment,
          invokingCwd: fixture.repoPath,
          rootSessionId: "session-2",
          runtimeGeneration: 1,
        }),
      ]);
      assert.notEqual(first.workspaceName, second.workspaceName);
      assert.notEqual(first.orchestrationChangeId, second.orchestrationChangeId);
      assert.equal(first.baseChangeId, undefined);
      assert.equal(first.sourceWorkspaceChangeId, undefined);
      assert.equal(second.baseChangeId, undefined);
      assert.equal(second.sourceWorkspaceChangeId, undefined);
      assert.equal(await fixture.currentChangeId(fixture.repoPath), userBefore);
      assert.match(
        await fixture.run(first.path, [
          "log",
          "--revision",
          "@",
          "--no-graph",
          "--template",
          "description.first_line()",
        ]),
        /^pi-tai: session session-1$/,
      );
      assert.match(
        await fixture.run(second.path, [
          "log",
          "--revision",
          "@",
          "--no-graph",
          "--template",
          "description.first_line()",
        ]),
        /^pi-tai: session session-2$/,
      );
      const recovered = await workspaces.allocate({
        enrollment,
        invokingCwd: fixture.repoPath,
        rootSessionId: "session-1",
        runtimeGeneration: 2,
      });
      assert.deepEqual(recovered, first);
      assert.equal(await fixture.currentChangeId(fixture.repoPath), userBefore);
      await workspaces.retryCleanup({
        enrollment,
        rootSessionId: "session-1",
        runtimeGeneration: 2,
      });
      assert.equal(
        (await fixture.run(fixture.repoPath, ["workspace", "list"])).includes(first.workspaceName),
        false,
      );
      assert.equal(await fixture.currentChangeId(fixture.repoPath), userBefore);
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  } finally {
    await fixture.dispose();
  }
});

test("repository coordinator preserves interrupted authority until reconciled", async () => {
  const store = new InMemoryRepositoryLeaseStore();
  const coordinator = new RepositoryMutationCoordinator(store, () => "now");
  await assert.rejects(
    coordinator.withLease(
      {
        repositoryId: "repo-1",
        rootSessionId: "session-1",
        runtimeGeneration: 1,
        operationId: "operation-1",
      },
      async () => {
        throw new Error("unknown mutation");
      },
    ),
    /unknown mutation/,
  );
  await assert.rejects(
    coordinator.withLease(
      {
        repositoryId: "repo-1",
        rootSessionId: "session-2",
        runtimeGeneration: 1,
        operationId: "operation-2",
      },
      async () => undefined,
    ),
    /unresolved mutation authority/,
  );
  await assert.rejects(
    coordinator.reconcile("repo-1", { mutationDidNotStart: false }),
    /requires semantic operation reconciliation/,
  );
  await coordinator.reconcile("repo-1", { mutationDidNotStart: true });
  assert.equal(
    await coordinator.withLease(
      {
        repositoryId: "repo-1",
        rootSessionId: "session-2",
        runtimeGeneration: 1,
        operationId: "operation-2",
      },
      async () => "ok",
    ),
    "ok",
  );
});
