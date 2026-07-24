import assert from "node:assert/strict";
import test from "node:test";
import { classifySharedShellCommand } from "../../packages/pi-tai/src/concurrency/source-guard.ts";

test("shared shell guard permits bounded inspection and validation", () => {
  assert.deepEqual(classifySharedShellCommand("rg -n TODO src && npm run typecheck"), {
    kind: "allowed", purpose: "validation",
  });
  assert.deepEqual(classifySharedShellCommand("jj log --revision @ --no-graph | head -20"), {
    kind: "allowed", purpose: "read",
  });
  assert.deepEqual(classifySharedShellCommand("cargo test --workspace"), {
    kind: "allowed", purpose: "validation",
  });
  assert.deepEqual(classifySharedShellCommand("find src -type f"), {
    kind: "allowed", purpose: "read",
  });
});

test("shared shell guard blocks source and JJ mutation or unknown execution", () => {
  assert.match(blocked("jj describe --message nope"), /deterministic JJ tools/);
  assert.match(blocked("sed -i s/a/b/ src/a.ts"), /mutate source files/);
  assert.match(blocked("node scripts/generate.ts"), /not an approved/);
  assert.match(blocked("find src -type f -delete"), /Mutating find/);
  assert.match(blocked("npm run format"), /not an approved/);
  assert.match(blocked("printf x > src/a.ts"), /redirection/);
  assert.match(blocked("python3 -c 'open(\"x\", \"w\")'"), /mutate source files/);
});

function blocked(command: string): string {
  const decision = classifySharedShellCommand(command);
  assert.equal(decision.kind, "blocked");
  return decision.kind === "blocked" ? decision.reason : "";
}
