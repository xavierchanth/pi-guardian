import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CAPABILITIES, CAPABILITY_NAMES, parseCapabilityCatalog } from "../../packages/pi-tai/src/agents/capabilities.ts";
import { resolveModel } from "../../packages/pi-tai/src/agents/models.ts";

describe("capability subagent catalog", () => {
  it("packages exactly the three versioned aliases", () => {
    assert.deepEqual(Object.keys(CAPABILITIES), [...CAPABILITY_NAMES]);
  });

  it("validates catalog objects exactly", () => {
    const valid = { version: 1, capabilities: Object.values(CAPABILITIES).map(c => ({ ...c, allowedBackends: [...c.allowedBackends] })) };
    assert.equal(parseCapabilityCatalog(valid).version, 1);
    assert.throws(() => parseCapabilityCatalog({ ...valid, surprise: true }), /not a supported field/);
    assert.throws(() => parseCapabilityCatalog({ ...valid, version: 2 }), /version must be 1/);
    assert.throws(() => parseCapabilityCatalog({ ...valid, capabilities: valid.capabilities.slice(1) }), /must define exactly/);
  });

  it("lets explicit model aliases select their backend when none is supplied", () => {
    const choice = resolveModel({ model: "opus" });
    assert.equal(choice.ok, true);
    if (choice.ok) assert.equal(choice.choice.backend, "claude");
  });
});
