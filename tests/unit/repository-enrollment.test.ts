import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileRepositoryEnrollmentStore, RepositoryEnrollmentService } from "../../packages/pi-tai/src/jj/repository-enrollment.ts";
import { RealJjFixture } from "../support/real-jj-fixture.ts";

test("repository enrollment preserves user workspace and installs private pi-tai policy", async () => {
  const fixture = await RealJjFixture.create("pi-tai-enrollment-");
  try {
    await fixture.seed({ changes: [{ description: "base", files: { "base.txt": "base\n" } }] });
    const before = await fixture.snapshot();
    const state = await mkdtemp(join(tmpdir(), "pi-tai-enrollment-state-"));
    try {
      const service = new RepositoryEnrollmentService({ store: new FileRepositoryEnrollmentStore(state), executor: fixture.executor });
      const planned = await service.plan(fixture.repoPath);
      assert.equal(planned.plan.initializationMode, "existing_jj");
      const receipt = await service.enroll(planned.plan, { authorizationId: "user-consent-1", planDigest: planned.plan.planDigest, authorizedAt: "now" });
      assert.match(receipt.managedWorkspaceRoot, /\.jj\/pi-tai\/workspaces$/);
      const after = await fixture.snapshot();
      assert.equal(after.workingCopies[0]?.changeId, before.workingCopies[0]?.changeId);
      assert.equal(after.workingCopies[0]?.contentHash, before.workingCopies[0]?.contentHash);
      assert.equal((await fixture.run(fixture.repoPath, ["config", "get", 'revset-aliases."pi_tai_private()"'])).trim(), 'description(glob:"pi-tai:*")');
      assert.match((await fixture.run(fixture.repoPath, ["config", "get", "git.private-commits"])).trim(), /pi_tai_private/);
      assert.equal((await service.verify(fixture.repoPath)).receiptDigest, receipt.receiptDigest);
      const again = await service.plan(fixture.repoPath);
      assert.equal(again.plan.nextPrivateCommits, again.plan.priorPrivateCommits);
      assert.doesNotMatch(again.plan.nextPrivateCommits, /pi_tai_private\(\).*pi_tai_private\(\)/);
    } finally { await rm(state, { recursive: true, force: true }); }
  } finally { await fixture.dispose(); }
});

test("interrupted enrollment persists the last safe boundary", async () => {
  const fixture = await RealJjFixture.create("pi-tai-enrollment-stop-");
  try {
    const state = await mkdtemp(join(tmpdir(), "pi-tai-enrollment-state-"));
    try {
      const service = new RepositoryEnrollmentService({ store: new FileRepositoryEnrollmentStore(state), executor: fixture.executor, failpoint: (boundary) => { if (boundary === "alias_configured") throw new Error("stop"); } });
      const planned = await service.plan(fixture.repoPath);
      await assert.rejects(service.enroll(planned.plan, { authorizationId: "user-consent-2", planDigest: planned.plan.planDigest, authorizedAt: "now" }), /stop/);
      const files = await import("node:fs/promises").then((fs) => fs.readdir(state));
      const records = await Promise.all(files.map((file) => readFile(join(state, file), "utf8").then(JSON.parse)));
      assert.ok(records.some((record) => record.phase === "attention_required" && record.lastSafeBoundary === "alias_configured"));
    } finally { await rm(state, { recursive: true, force: true }); }
  } finally { await fixture.dispose(); }
});
