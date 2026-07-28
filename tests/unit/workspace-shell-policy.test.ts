import assert from "node:assert/strict";
import test from "node:test";
import { classifyWorkspaceShellCommand } from "../../packages/pi-tai/src/concurrency/workspace-shell-policy.ts";

test("managed-workspace shell policy permits bounded inspection and validation", () => {
  assert.deepEqual(classifyWorkspaceShellCommand("rg -n TODO src && npm run typecheck"), {
    kind: "allowed", purpose: "validation",
  });
  assert.deepEqual(classifyWorkspaceShellCommand("jj log --revision @ --no-graph | head -20"), {
    kind: "allowed", purpose: "read",
  });
  assert.deepEqual(classifyWorkspaceShellCommand("cargo test --workspace"), {
    kind: "allowed", purpose: "validation",
  });
  assert.deepEqual(classifyWorkspaceShellCommand("find src -type f"), {
    kind: "allowed", purpose: "read",
  });
});

test("managed-workspace shell policy blocks source and JJ mutation or unknown execution", () => {
  assert.match(blocked("jj describe --message nope"), /deterministic JJ tools/);
  assert.match(blocked("sed -i s/a/b/ src/a.ts"), /mutate source files/);
  assert.match(blocked("node scripts/generate.ts"), /not an approved/);
  assert.match(blocked("find src -type f -delete"), /Mutating find/);
  assert.match(blocked("npm run format"), /not an approved/);
  assert.match(blocked("printf x > src/a.ts"), /redirection/);
  assert.match(blocked("python3 -c 'open(\"x\", \"w\")'"), /mutate source files/);
});

function blocked(command: string): string {
  const decision = classifyWorkspaceShellCommand(command);
  assert.equal(decision.kind, "blocked");
  return decision.kind === "blocked" ? decision.reason : "";
}
