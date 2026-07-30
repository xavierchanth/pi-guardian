import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JjCli } from "../../packages/pi-tai/src/isolation/jj.ts";
import type { JjExecutionRequest, JjExecutor } from "../../packages/pi-tai/src/jj/executor.ts";

function recording(stdout = ""): { cli: JjCli; requests: JjExecutionRequest[] } {
  const requests: JjExecutionRequest[] = [];
  const executor = {
    async execute(request: JjExecutionRequest) {
      requests.push(request);
      return { kind: "success" as const, stdout, stderr: "", exitCode: 0 as const, durationMs: 0 };
    },
    async probe() { return { kind: "available" as const, binary: "jj", version: "0.43.0" as const }; },
  } satisfies JjExecutor;
  return { cli: new JjCli(executor), requests };
}

describe("isolation jj cosmetic topology commands", () => {
  it("uses the jj 0.43-valid exact redundant-parent revset", async () => {
    const { cli, requests } = recording("x");
    assert.equal(await cli.hasRedundantParents("/repo", "kkkk"), true);
    assert.deepEqual(requests[0]?.args, [
      "log", "--revision",
      "parents(exactly(change_id(kkkk), 1)) & ancestors(parents(exactly(change_id(kkkk), 1))-)",
      "--limit", "1", "--no-graph", "--template", "\"x\"",
    ]);
    assert.equal(requests[0]?.access, "read");
  });

  it("bounds simplify-parents to the exact target revision", async () => {
    const { cli, requests } = recording();
    await cli.simplifyParents("/repo", "kkkk");
    assert.deepEqual(requests[0]?.args, ["simplify-parents", "--revision", "exactly(change_id(kkkk), 1)"]);
    assert.equal(requests[0]?.access, "write");
  });

  it("checks descendants and required heads with exact revsets", async () => {
    const { cli, requests } = recording();
    await cli.hasDescendants("/repo", "kkkk");
    await cli.areAncestorsOf("/repo", ["llll", "mmmm"], "kkkk");
    assert.equal(requests[0]?.args[2], "(exactly(change_id(kkkk), 1)):: ~ exactly(change_id(kkkk), 1)");
    assert.equal(requests[1]?.args[2], "(exactly(change_id(llll), 1) | exactly(change_id(mmmm), 1)) ~ ancestors(exactly(change_id(kkkk), 1))");
  });
});
