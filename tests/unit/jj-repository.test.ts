import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { changeId } from "../../packages/pi-tai/src/core/jj/domain.ts";
import { jjSuccess, ScriptedJjExecutor } from "../../packages/pi-tai/src/core/jj/executor.ts";
import { FileSharedSourceStore } from "../../packages/pi-tai/src/core/jj/persistence.ts";
import {
  exactChange,
  JjRepositoryKernel,
  literalRootFileset,
} from "../../packages/pi-tai/src/core/jj/repository.ts";

const CURRENT = "a".repeat(32);
const PARENT = "b".repeat(32);

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pi-tai-jj-kernel-"));
  await mkdir(join(root, ".jj", "repo"), { recursive: true });
  const executor = new ScriptedJjExecutor(async (request) => {
    const args = [...request.args];
    if (args[0] === "root") return jjSuccess(`${root}\n`);
    if (args[0] === "workspace") return jjSuccess(`default|${CURRENT}\n`);
    if (args[0] === "config") return jjSuccess(`description('wip:*')\n`);
    if (args.includes("operation")) return jjSuccess("jj-operation-1\n");
    if (args[0] === "log") {
      const revision = args[args.indexOf("--revision") + 1];
      const id = revision === "@" || revision === exactChange(changeId(CURRENT)) ? CURRENT : PARENT;
      const template = args[args.indexOf("--template") + 1] ?? "";
      return template.includes("commit_id")
        ? jjSuccess(`${id}|${"c".repeat(40)}|empty|clean|mutable|${PARENT}|\n`)
        : jjSuccess(`${id}\n`);
    }
    if (args[0] === "diff") return jjSuccess("diff evidence\n");
    return jjSuccess();
  });
  const kernel = new JjRepositoryKernel({
    executor,
    store: new FileSharedSourceStore(join(root, "state")),
    now: () => "2026-01-01T00:00:00.000Z",
  });
  return { root, executor, kernel };
}

test("repository kernel opens one opaque source and resolves every tracked ID exactly", async () => {
  const { root, executor, kernel } = await setup();
  try {
    const source = await kernel.openSource(root);
    const inspection = await kernel.inspect(source);
    assert.equal(inspection.current.changeId, CURRENT);
    assert.equal(inspection.current.empty, true);
    assert.equal(inspection.privateCommitSelector, "description('wip:*')");
    const resolved = await kernel.resolveChange(source, changeId(CURRENT));
    assert.equal(resolved.changeId, CURRENT);
    const trackedRequest = executor.requests.find((request) =>
      request.args.includes(exactChange(changeId(CURRENT))),
    );
    assert.ok(trackedRequest);
    for (const request of executor.requests) {
      assert.equal(request.args.includes("config") && request.args.includes("set"), false);
      assert.equal(
        request.args.some((arg) => /^-[^-]/.test(arg)),
        false,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository mutation mutex serializes callers for one repository", async () => {
  const { root, kernel } = await setup();
  try {
    const source = await kernel.openSource(root);
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = kernel.withRepositoryMutation(source, async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
    });
    while (!order.length) await new Promise((resolve) => setTimeout(resolve, 1));
    const second = kernel.withRepositoryMutation(source, async () => {
      order.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(order, ["first:start"]);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first:start", "first:end", "second"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository helpers construct bounded exact revsets and literal filesets", () => {
  assert.equal(exactChange(changeId(CURRENT)), `exactly(change_id(${CURRENT}), 1)`);
  assert.equal(literalRootFileset('src/a"b.ts'), 'root:"src/a\\"b.ts"');
});
