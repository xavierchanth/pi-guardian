import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPiTaiConfig } from "../../packages/pi-tai/src/config/load.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-tai-config-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  return { agentDir, cwd };
}

test("returns immutable defaults when files are absent", () => {
  const paths = fixture();
  const loaded = loadPiTaiConfig({ ...paths, projectTrusted: false });
  assert.equal(loaded.config.sessionTitle.effort, "minimal");
  assert.equal(loaded.config.ansiTheme.darkTheme, "ansi-dark");
  assert.ok(Object.isFrozen(loaded.config));
  assert.deepEqual(loaded.warnings, []);
});

test("trusted project values override valid global values", () => {
  const paths = fixture();
  writeFileSync(join(paths.agentDir, "pi-tai.json"), JSON.stringify({
    sessionTitle: { provider: "global-provider", model: "global-model", maxWords: 8 },
    ansiTheme: { darkTheme: "global-dark" },
  }));
  writeFileSync(join(paths.cwd, ".pi", "pi-tai.json"), JSON.stringify({
    sessionTitle: { model: "project-model" },
    ansiTheme: { lightTheme: "project-light" },
  }));

  const loaded = loadPiTaiConfig({ ...paths, projectTrusted: true });
  assert.deepEqual(loaded.config.sessionTitle, {
    provider: "global-provider",
    model: "project-model",
    effort: "minimal",
    maxWords: 8,
    fallback: "heuristic",
  });
  assert.equal(loaded.config.ansiTheme.darkTheme, "global-dark");
  assert.equal(loaded.config.ansiTheme.lightTheme, "project-light");
});

test("untrusted project configuration is ignored", () => {
  const paths = fixture();
  writeFileSync(join(paths.agentDir, "pi-tai.json"), JSON.stringify({ sessionTitle: { model: "global" } }));
  writeFileSync(join(paths.cwd, ".pi", "pi-tai.json"), JSON.stringify({ sessionTitle: { model: "project" } }));

  const loaded = loadPiTaiConfig({ ...paths, projectTrusted: false });
  assert.equal(loaded.config.sessionTitle.model, "global");
});

test("invalid overrides are ignored without erasing valid global values", () => {
  const paths = fixture();
  writeFileSync(join(paths.agentDir, "pi-tai.json"), JSON.stringify({
    sessionTitle: { provider: "global", maxWords: 7 },
  }));
  writeFileSync(join(paths.cwd, ".pi", "pi-tai.json"), JSON.stringify({
    sessionTitle: { provider: "", maxWords: 99, surprise: true },
    unknown: true,
  }));

  const loaded = loadPiTaiConfig({ ...paths, projectTrusted: true });
  assert.equal(loaded.config.sessionTitle.provider, "global");
  assert.equal(loaded.config.sessionTitle.maxWords, 7);
  assert.ok(loaded.warnings.some((warning) => warning.includes("sessionTitle.maxWords")));
  assert.ok(loaded.warnings.some((warning) => warning.includes("Unknown top-level key")));
});

test("invalid JSON produces a warning and safe defaults", () => {
  const paths = fixture();
  writeFileSync(join(paths.agentDir, "pi-tai.json"), "{");
  const loaded = loadPiTaiConfig({ ...paths, projectTrusted: false });
  assert.equal(loaded.config.sessionTitle.maxWords, 6);
  assert.equal(loaded.warnings.length, 1);
});
