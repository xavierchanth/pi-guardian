import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MODEL_ALIAS_NAMES,
  MODEL_CATALOG,
  parseModelCatalog,
  resolveModel,
} from "../../packages/pi-tai/src/agents/models.ts";

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

  it("loads the supported model aliases from the packaged catalog", () => {
    assert.equal(MODEL_CATALOG.version, 1);
    assert.deepEqual(MODEL_ALIAS_NAMES, ["fable", "glm", "kimi", "luna", "opus", "sol", "sonnet", "terra"]);
  });

  it("offers Sol, Terra, and Luna through OpenAI Codex", () => {
    for (const [alias, model] of [
      ["sol", "gpt-5.6-sol"],
      ["terra", "gpt-5.6-terra"],
      ["luna", "gpt-5.6-luna"],
    ]) {
      assert.deepEqual(choice({ model: alias }), {
        backend: "pi", provider: "openai-codex", model, effort: "low",
      });
      assert.equal(choice({ model: alias, backend: "codex" }).backend, "codex");
    }
  });

  it("sends Claude aliases only to the Claude Code harness", () => {
    assert.deepEqual(choice({ model: "fable" }), {
      backend: "claude", provider: "anthropic", model: "claude-fable-5", effort: "medium",
    });
    for (const model of ["fable", "opus", "sonnet"]) {
      assert.equal(choice({ model }).backend, "claude");
      for (const backend of ["pi", "codex"] as const) {
        const result = resolveModel({ model, backend });
        assert.equal(result.ok, false);
        assert.match(result.ok ? "" : result.reason, /cannot run.*use claude/);
      }
    }
  });

  it("offers GLM 5.2 and Kimi K3 through OpenCode Go on Pi", () => {
    assert.deepEqual(choice({ model: "glm" }), {
      backend: "pi", provider: "opencode-go", model: "glm-5.2", effort: "low",
    });
    assert.deepEqual(choice({ model: "kimi" }), {
      backend: "pi", provider: "opencode-go", model: "kimi-k3", effort: "low",
    });
    assert.equal(resolveModel({ model: "glm", backend: "claude" }).ok, false);
    assert.equal(resolveModel({ model: "kimi", backend: "codex" }).ok, false);
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

  it("accepts compatible explicit provider/model ids", () => {
    assert.deepEqual(choice({ model: "anthropic/claude-sonnet-5", backend: "claude" }), {
      backend: "claude", provider: "anthropic", model: "claude-sonnet-5", effort: "medium",
    });
    assert.deepEqual(choice({ model: "opencode-go/glm-5.2" }), {
      backend: "pi", provider: "opencode-go", model: "glm-5.2", effort: "low",
    });
  });

  it("rejects explicit provider/model ids on an incompatible harness", () => {
    assert.equal(resolveModel({ model: "anthropic/claude-sonnet-5", backend: "pi" }).ok, false);
    assert.equal(resolveModel({ model: "openrouter/anthropic/claude-sonnet-5", backend: "pi" }).ok, false);
    assert.equal(resolveModel({ model: "opencode-go/kimi-k3", backend: "claude" }).ok, false);
  });

  it("rejects invalid packaged catalog combinations", () => {
    assert.throws(() => parseModelCatalog({
      version: 1,
      aliases: [{
        name: "opus",
        backend: "pi",
        provider: "anthropic",
        model: "claude-opus-5",
        effort: "medium",
        allowedBackends: ["pi"],
        purpose: "invalid",
      }],
    }), /allowedBackends must be exactly claude/);
  });

  it("rejects a bare name that is neither alias nor provider/model", () => {
    const result = resolveModel({ model: "gpt-9" });

    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /neither a known alias .*fable.*nor a provider\/model/);
  });
});
