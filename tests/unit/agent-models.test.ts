import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MODEL_ALIAS_NAMES, resolveModel } from "../../packages/pi-tai/src/agents/models.ts";

function choice(input: Parameters<typeof resolveModel>[0]) {
  const result = resolveModel(input);
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  return result.ok ? result.choice : undefined!;
}

describe("model resolution", () => {
  it("defaults to sol at low effort when nothing is named", () => {
    assert.deepEqual(choice({}), {
      backend: "pi", provider: "openai-codex", model: "gpt-5.6-sol", effort: "low",
    });
  });

  it("agrees with itself whether sol is reached by name or by default", () => {
    assert.deepEqual(choice({}), choice({ model: "sol" }));
    assert.deepEqual(choice({ backend: "pi" }), choice({ model: "sol" }));
  });

  it("defaults each harness to its own model and effort", () => {
    assert.deepEqual(choice({ backend: "claude" }), {
      backend: "claude", provider: "anthropic", model: "claude-opus-5", effort: "medium",
    });
    assert.deepEqual(choice({ backend: "codex" }), {
      backend: "codex", provider: "openai-codex", model: "gpt-5.6-sol", effort: "low",
    });
  });

  it("offers only sol, opus and fable", () => {
    assert.deepEqual(MODEL_ALIAS_NAMES, ["fable", "opus", "sol"]);
  });

  it("sends anthropic models to the claude harness without being told", () => {
    assert.deepEqual(choice({ model: "fable" }), {
      backend: "claude", provider: "anthropic", model: "claude-fable-5", effort: "medium",
    });
    assert.equal(choice({ model: "opus" }).backend, "claude");
  });

  it("lets an explicit harness override an alias's preference", () => {
    assert.deepEqual(choice({ model: "fable", backend: "pi" }), {
      backend: "pi", provider: "anthropic", model: "claude-fable-5", effort: "medium",
    });
  });

  it("keeps the alias's model when a harness is named explicitly", () => {
    // "sol on codex" is a real request; the alias must not drag it back to pi.
    assert.deepEqual(choice({ model: "sol", backend: "codex" }), {
      backend: "codex", provider: "openai-codex", model: "gpt-5.6-sol", effort: "low",
    });
  });

  it("lets an explicit effort override the alias", () => {
    assert.equal(choice({ model: "opus", effort: "low" }).effort, "low");
    assert.equal(choice({ model: "fable", effort: "max" }).effort, "max");
  });

  it("is case-insensitive about aliases", () => {
    assert.equal(choice({ model: "Fable" }).model, "claude-fable-5");
  });

  it("accepts an explicit provider/model id", () => {
    assert.deepEqual(choice({ model: "anthropic/claude-sonnet-5", backend: "claude" }), {
      backend: "claude", provider: "anthropic", model: "claude-sonnet-5", effort: "medium",
    });
  });

  it("rejects a bare name that is neither alias nor provider/model", () => {
    const result = resolveModel({ model: "gpt-9" });

    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /neither a known alias .*fable.*nor a provider\/model/);
  });
});
