import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CAPABILITIES,
  CAPABILITY_NAMES,
  parseCapabilityCatalog,
} from "../../packages/pi-tai/src/agents/capabilities.ts";
import { resolveModel } from "../../packages/pi-tai/src/agents/models.ts";

describe("capability subagent catalog", () => {
  it("packages researcher as the sole versioned alias", () => {
    assert.deepEqual(CAPABILITY_NAMES, ["researcher"]);
    assert.deepEqual(Object.keys(CAPABILITIES), [...CAPABILITY_NAMES]);
  });

  it("rejects malformed catalog objects", () => {
    const valid = {
      version: 1,
      capabilities: Object.values(CAPABILITIES).map((c) => ({
        ...c,
        allowedBackends: [...c.allowedBackends],
      })),
    };
    const capability = valid.capabilities[0]!;
    assert.equal(parseCapabilityCatalog(valid).version, 1);
    assert.throws(
      () => parseCapabilityCatalog({ ...valid, surprise: true }),
      /not a supported field/,
    );
    assert.throws(() => parseCapabilityCatalog({ ...valid, version: 2 }), /version must be 1/);
    assert.throws(
      () => parseCapabilityCatalog({ ...valid, capabilities: [] }),
      /must define exactly/,
    );
    assert.throws(
      () =>
        parseCapabilityCatalog({ ...valid, capabilities: [{ ...capability, effort: "extreme" }] }),
      /effort must be one of/,
    );
    assert.throws(
      () =>
        parseCapabilityCatalog({ ...valid, capabilities: [{ ...capability, model: "unknown" }] }),
      /model must be a known model alias/,
    );
    assert.throws(
      () =>
        parseCapabilityCatalog({ ...valid, capabilities: [{ ...capability, backend: "browser" }] }),
      /backend must be one of/,
    );
    assert.throws(
      () => parseCapabilityCatalog({ ...valid, capabilities: [capability, capability] }),
      /Duplicate capability/,
    );
  });

  it("lets explicit model aliases select their backend when none is supplied", () => {
    const choice = resolveModel({ model: "opus" });
    assert.equal(choice.ok, true);
    if (choice.ok) assert.equal(choice.choice.backend, "claude");
  });
});
