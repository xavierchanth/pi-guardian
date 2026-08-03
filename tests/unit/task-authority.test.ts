import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  TaskAgentAuthority,
  TaskInvalidError,
  TaskUnavailableError,
} from "../../packages/pi-tai/src/core/tasks/agent-authority.ts";
import {
  HumanTaskAuthority,
  issueHumanCapability,
} from "../../packages/pi-tai/src/core/tasks/host-authority.ts";
import { resolveStoragePaths } from "../../packages/pi-tai/src/core/storage/paths.ts";
import { openDurableDatabase } from "../../packages/pi-tai/src/core/storage/sqlite.ts";

function fixture() {
  const paths = resolveStoragePaths({}, mkdtempSync(join(tmpdir(), "tasks-v7-")));
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
  db.prepare("INSERT INTO repository VALUES(?,?,?,?,?,?,?,?)").run(
    "foreign",
    "fp2",
    0,
    "store2",
    "/foreign",
    1,
    now,
    now,
  );
  const human = HumanTaskAuthority.inject(db, paths, "repo", issueHumanCapability("alice"));
  const agent = new TaskAgentAuthority(db, paths, "repo", "agent:s1");
  return { db, paths, human, agent };
}

async function rejects(error: new (...args: never[]) => Error, fn: () => unknown) {
  assert.throws(fn, error);
}

test("MG-3 exact agent transitions, actionable validation, privacy, replay, and archive/restore", async () => {
  const { db, paths, human, agent } = fixture();
  const original = human.create("create-op-001", "  A   task ", "body");
  assert.deepEqual(human.create("create-op-001", "ignored", "ignored"), original);
  human.transition("open-ready-01", original.task.taskId, "open", 1, "ready");

  await rejects(TaskInvalidError, () =>
    agent.update(original.task.taskId, { action: "transition", to: "ready" }),
  );
  await rejects(TaskInvalidError, () =>
    agent.update(original.task.taskId, { action: "add_note", note: " " }),
  );
  await rejects(TaskInvalidError, () =>
    agent.update(original.task.taskId, { action: "set_title", title: "x".repeat(513) }),
  );
  agent.update(original.task.taskId, { action: "transition", to: "doing" });
  agent.update(original.task.taskId, { action: "transition", to: "blocked" });
  agent.update(original.task.taskId, { action: "transition", to: "ready" });
  agent.update(original.task.taskId, { action: "transition", to: "doing" });
  const done = agent.update(original.task.taskId, { action: "transition", to: "done" });
  assert.equal(done.state, "done");
  assert.equal(
    db
      .prepare("SELECT archived_at IS NOT NULL archived FROM task WHERE task_id=?")
      .get(original.task.taskId)?.archived,
    1,
  );
  assert.deepEqual(human.archive(original.task.taskId), human.archive(original.task.taskId));
  assert.equal(human.restore(original.task.taskId).state, "ready");
  const doing = human.transition(
    "human-doing-archive",
    original.task.taskId,
    "ready",
    1,
    "doing",
  );
  assert.equal(doing.task.state, "doing");
  assert.equal(human.archive(original.task.taskId).state, "doing");
  assert.equal(human.restore(original.task.taskId).state, "doing");
  assert.equal(human.archive(original.task.taskId).state, "doing");

  const hidden = ["missing", original.task.taskId];
  const foreign = HumanTaskAuthority.inject(
    db,
    paths,
    "foreign",
    issueHumanCapability("bob"),
  ).create("foreign-op-01", "secret", "secret");
  hidden.push(foreign.task.taskId);
  for (const id of hidden) {
    await rejects(TaskUnavailableError, () => agent.read(id));
    await rejects(TaskUnavailableError, () => agent.update(id, null as never));
  }
});

test("MG-3 reconcile isolates corrupt and stale intents and continues later operations", () => {
  const { db, human } = fixture();
  const good = human.create("good-create-01", "good", "body");
  human.transition("good-ready-01", good.task.taskId, "open", 1, "ready");
  const now = new Date().toISOString();
  for (const [id, kind, payload] of [
    ["bad-json-001", "created", "{"],
    ["bad-stage-01", "revised", "{}"],
  ]) {
    db.prepare("INSERT INTO task_operation VALUES(?,?,?,?,?,'intent',?,?,?,?)").run(
      id,
      "repo",
      "alice",
      good.task.taskId,
      kind,
      9,
      "0".repeat(64),
      payload,
      now,
    );
  }
  assert.doesNotThrow(() => human.reconcile());
  assert.deepEqual(
    db
      .prepare(
        "SELECT status FROM task_operation WHERE operation_id IN('bad-json-001','bad-stage-01') ORDER BY operation_id",
      )
      .all()
      .map((row: any) => row.status),
    ["failed", "failed"],
  );
  assert.equal(human.create("after-fault-01", "still works", "ok").task.state, "open");
});
