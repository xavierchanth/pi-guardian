import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerApprovalGuardian } from "../../packages/pi-tai/src/guardian/register.ts";

test("loads and registers the stock Approval Guardian factory exactly once", async () => {
  let loads = 0;
  let registrations = 0;
  const pi = {} as ExtensionAPI;

  await registerApprovalGuardian(pi, async () => {
    loads++;
    return {
      default(received) {
        assert.equal(received, pi);
        registrations++;
      },
    };
  });

  assert.equal(loads, 1);
  assert.equal(registrations, 1);
});
