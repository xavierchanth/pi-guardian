import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FileWorkspaceRegistry } from "../../packages/pi-tai/src/core/isolation/registry.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function registry(root: string, identities: Map<number, string | undefined>) {
  return new FileWorkspaceRegistry(root, {
    staleAfterMs: 0,
    retryMs: 2,
    processIdentity: async (pid) => identities.get(pid),
  });
}

async function staleLock(root: string, suffix: string, token: string, pid = 999_999) {
  const path = join(root, `workspaces.json.${suffix}.lock`);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "owner.json"),
    JSON.stringify({
      pid,
      processIdentity: "old-start",
      createdAt: new Date(0).toISOString(),
      token,
    }),
  );
  return path;
}

describe("workspace registry locks", () => {
  it("serializes two contenders and prevents operation-lock lost updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "pitai-lock-"));
    const ids = new Map([[process.pid, "current-start"]]);
    const a = registry(root, ids);
    const b = registry(root, ids);
    let active = 0;
    let maximum = 0;
    let value = 0;
    const update = (r: FileWorkspaceRegistry) =>
      r.withOperationLock(async () => {
        active++;
        maximum = Math.max(maximum, active);
        const observed = value;
        await sleep(15);
        value = observed + 1;
        active--;
      });
    await Promise.all([update(a), update(b)]);
    assert.equal(maximum, 1);
    assert.equal(value, 2);
  });

  it("takes over exactly one stale generation while concurrent contenders remain exclusive", async () => {
    const root = await mkdtemp(join(tmpdir(), "pitai-lock-"));
    await staleLock(root, "operation", "11111111-1111-4111-8111-111111111111");
    const ids = new Map<number, string | undefined>([[process.pid, "current-start"]]);
    const contenders = [registry(root, ids), registry(root, ids)];
    let active = 0;
    let maximum = 0;
    await Promise.all(
      contenders.map((r) =>
        r.withOperationLock(async () => {
          active++;
          maximum = Math.max(maximum, active);
          await sleep(10);
          active--;
        }),
      ),
    );
    assert.equal(maximum, 1);
    assert.ok((await readdir(root)).some((name) => name.includes(".claim-11111111")));
  });

  it("a delayed stale observation cannot claim a successor generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pitai-lock-"));
    const token = "22222222-2222-4222-8222-222222222222";
    const lock = await staleLock(root, "operation", token);
    // Represents the winning contender's retained generation proof.
    await mkdir(`${lock}.claim-${token}`);
    await writeFile(join(`${lock}.claim-${token}`, "owner.json"), "retained generation proof");
    await assert.rejects(
      new FileWorkspaceRegistry(root, {
        staleAfterMs: 0,
        retryMs: 1,
        now: (() => {
          let n = Date.now();
          return () => {
            n += 5_000;
            return n;
          };
        })(),
        processIdentity: async (pid) => (pid === process.pid ? "current" : undefined),
      }).withOperationLock(async () => {}),
      /Timed out/,
    );
    assert.equal(JSON.parse(await readFile(join(lock, "owner.json"), "utf8")).token, token);
  });

  it("does not mistake PID reuse for the original owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "pitai-lock-"));
    await staleLock(root, "operation", "33333333-3333-4333-8333-333333333333", 42);
    const ids = new Map<number, string | undefined>([
      [process.pid, "current"],
      [42, "reused-start"],
    ]);
    let entered = false;
    await registry(root, ids).withOperationLock(async () => {
      entered = true;
    });
    assert.equal(entered, true);
  });

  it("non-owner unlock fails closed and leaves the lock generation intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "pitai-lock-"));
    const r = registry(root, new Map([[process.pid, "current"]]));
    const lock = join(root, "workspaces.json.operation.lock");
    const owner = await (r as any).acquireLock(lock, 100);
    await assert.rejects(
      (r as any).releaseLock(lock, { ...owner, token: crypto.randomUUID() }),
      /not owned/,
    );
    assert.equal(JSON.parse(await readFile(join(lock, "owner.json"), "utf8")).token, owner.token);
    await (r as any).releaseLock(lock, owner);
  });

  it("retains incomplete stale claim artifacts and bounds contention", async () => {
    const root = await mkdtemp(join(tmpdir(), "pitai-lock-"));
    const lock = join(root, "workspaces.json.operation.lock");
    await mkdir(lock, { recursive: true }); // crash before owner metadata
    const r = new FileWorkspaceRegistry(root, {
      retryMs: 1,
      now: (() => {
        let n = 0;
        return () => {
          n += 5_000;
          return n;
        };
      })(),
      processIdentity: async () => "current",
    });
    await assert.rejects(
      r.withOperationLock(async () => {}),
      /Timed out/,
    );
    assert.deepEqual(await readdir(lock), []);
  });

  it("registry writes from separate instances do not lose records", async () => {
    const root = await mkdtemp(join(tmpdir(), "pitai-lock-"));
    const ids = new Map([[process.pid, "current"]]);
    const record = (id: string) => ({ id, version: 2, rootSessionId: "r" }) as any;
    const a = registry(root, ids);
    const b = registry(root, ids);
    await Promise.all([a.put(record("a")), b.put(record("b"))]);
    assert.deepEqual((await a.list()).map((x) => x.id).sort(), ["a", "b"]);
  });
});
