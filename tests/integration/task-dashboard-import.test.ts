import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  TaskDashboardAdapter,
  importFixedRevision,
} from "../../packages/pi-tai/src/core/tasks/dashboard.ts";
import {
  HumanTaskAuthority,
  issueHumanCapability,
} from "../../packages/pi-tai/src/core/tasks/host-authority.ts";
import { resolveStoragePaths } from "../../packages/pi-tai/src/core/storage/paths.ts";
import { openDurableDatabase } from "../../packages/pi-tai/src/core/storage/sqlite.ts";

function fixture() {
  const paths = resolveStoragePaths({}, mkdtempSync(join(tmpdir(), "task-dashboard-")));
  const db = openDurableDatabase({ paths });
  const now = new Date().toISOString();
  db.prepare("INSERT INTO repository VALUES(?,?,?,?,?,?,?,?)").run(
    "repo",
    "fp",
    0,
    "store",
    "/repo",
    1,
    now,
    now,
  );
  const authority = HumanTaskAuthority.inject(db, paths, "repo", issueHumanCapability("alice"));
  return { paths, db, authority };
}

test("task dashboard reads current and archived rows and restores with attributed audits", () => {
  const { paths, db, authority } = fixture();
  const made = authority.create("create-dashboard-1", "Real row", "one");
  authority.transition("ready-dashboard-1", made.task.taskId, "open", 1, "ready");
  const adapter = new TaskDashboardAdapter(db, "repo", authority, paths);
  assert.deepEqual(
    adapter.list(false).map((r) => r.title),
    ["Real row"],
  );
  adapter.transition(adapter.list(false)[0]!, "doing");
  adapter.transition(adapter.list(false)[0]!, "done");
  assert.equal(adapter.list(true)[0]?.state, "done");
  adapter.archiveOrRestore(adapter.list(true)[0]!);
  assert.equal(adapter.list(false)[0]?.state, "ready");
  assert.deepEqual(
    db
      .prepare("SELECT actor,principal,operation FROM task_audit ORDER BY rowid DESC LIMIT 2")
      .all()
      .map((row) => ({ ...row })),
    [
      { actor: "human", principal: "alice", operation: "transition" },
      { actor: "human", principal: "alice", operation: "restore" },
    ],
  );
});

test("dashboard import prompts for and delivers the selected immutable revision", async () => {
  const { paths, db, authority } = fixture();
  const made = authority.create("create-ui-import", null, "Derived title\nbody");
  authority.revise("revise-ui-import", made.task.taskId, 1, "latest");
  const digest = createHash("sha256").update("Derived title\nbody").digest("hex");
  const prompts = ["1"];
  const labels: string[] = [];
  const events: string[] = [];
  const adapter = new TaskDashboardAdapter(db, "repo", authority, paths, {
    principal: "alice",
    async input(label) {
      labels.push(label);
      return prompts.shift();
    },
    send(message) {
      assert.match(message, /Derived title/);
      assert.doesNotMatch(message, /latest/);
      events.push("send");
    },
    trace(event) {
      assert.equal(event.digest, digest);
      events.push("trace");
    },
  });
  assert.equal(adapter.list(false)[0]?.title, "Derived title");
  const imported = await adapter.importRevision(adapter.list(false)[0]!);
  assert.equal(imported?.revision, 1);
  assert.equal(labels.length, 1);
  assert.match(labels[0]!, /immutable revision/);
  assert.doesNotMatch(labels[0]!, /digest/i);
  assert.deepEqual(events, ["send", "trace"]);
});

test("fixed import never switches to latest and receipts before nextTurn delivery and trace", async () => {
  const { paths, db, authority } = fixture();
  const made = authority.create("create-import-01", "Import", "revision one");
  authority.revise("revise-import-01", made.task.taskId, 1, "revision two");
  const digest = createHash("sha256").update("revision one").digest("hex");
  const order: string[] = [];
  const imported = await importFixedRevision({
    db,
    paths,
    repoId: "repo",
    principal: "alice",
    taskId: made.task.taskId,
    revision: 1,
    expectedDigest: digest,
    sendMessage(message, options) {
      assert.equal(db.prepare("SELECT count(*) n FROM task_delivery").get()?.n, 1);
      assert.match(message, /revision one/);
      assert.doesNotMatch(message, /revision two/);
      assert.deepEqual(options, { deliverAs: "nextTurn", triggerTurn: false });
      order.push("send");
    },
    appendTrace(event) {
      assert.equal(event.revision, 1);
      order.push("trace");
    },
  });
  assert.equal(imported.digest, digest);
  assert.deepEqual(order, ["send", "trace"]);
  const revisionPath = join(paths.taskBodies, "repo", made.task.taskId, "1.md");
  chmodSync(revisionPath, 0o600);
  writeFileSync(revisionPath, "tampered");
  await assert.rejects(
    () =>
      importFixedRevision({
        db,
        paths,
        repoId: "repo",
        principal: "alice",
        taskId: made.task.taskId,
        revision: 1,
        expectedDigest: digest,
        sendMessage() {
          throw new Error("must not send");
        },
        appendTrace() {},
      }),
    /digest mismatch/,
  );
});
