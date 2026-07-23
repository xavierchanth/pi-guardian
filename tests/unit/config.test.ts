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
  assert.deepEqual(loaded.config.notifications, {
    reviewFailure: true,
    agentCompletion: true,
  });
  assert.deepEqual(loaded.config.compaction, {
    enabled: true,
    thresholdPercent: 90,
  });
  assert.ok(Object.isFrozen(loaded.config));
  assert.deepEqual(loaded.warnings, []);
});

test("trusted project values override valid global values", () => {
  const paths = fixture();
  writeFileSync(join(paths.agentDir, "pi-tai.json"), JSON.stringify({
    sessionTitle: { provider: "global-provider", model: "global-model", maxWords: 8 },
    ansiTheme: { darkTheme: "global-dark" },
    notifications: { reviewFailure: false },
    compaction: { thresholdPercent: 85 },
  }));
  writeFileSync(join(paths.cwd, ".pi", "pi-tai.json"), JSON.stringify({
    sessionTitle: { model: "project-model" },
    ansiTheme: { lightTheme: "project-light" },
    notifications: { agentCompletion: false },
    compaction: { enabled: false, thresholdPercent: 92.5 },
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
  assert.deepEqual(loaded.config.notifications, {
    reviewFailure: false,
    agentCompletion: false,
  });
  assert.deepEqual(loaded.config.compaction, {
    enabled: false,
    thresholdPercent: 92.5,
  });
});

test("model profile arrays replace defaults by trusted scope and preserve declaration order", () => {
  const paths = fixture();
  writeFileSync(join(paths.agentDir, "pi-tai.json"), JSON.stringify({
    modelProfiles: [
      { name: "global-low", provider: "openai-codex", model: "global", effort: "low" },
    ],
  }));
  writeFileSync(join(paths.cwd, ".pi", "pi-tai.json"), JSON.stringify({
    modelProfiles: [
      { name: "project-high", provider: "openai-codex", model: "project", effort: "high" },
      { name: "project-low", provider: "openai-codex", model: "project", effort: "low" },
    ],
  }));
  const trusted = loadPiTaiConfig({ ...paths, projectTrusted: true });
  assert.deepEqual(trusted.config.modelProfiles.map((profile) => profile.name), ["project-high", "project-low"]);
  const untrusted = loadPiTaiConfig({ ...paths, projectTrusted: false });
  assert.deepEqual(untrusted.config.modelProfiles.map((profile) => profile.name), ["global-low"]);
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
    notifications: { reviewFailure: "yes", surprise: true },
    compaction: { enabled: "yes", thresholdPercent: 101, surprise: true },
    unknown: true,
  }));

  const loaded = loadPiTaiConfig({ ...paths, projectTrusted: true });
  assert.equal(loaded.config.sessionTitle.provider, "global");
  assert.equal(loaded.config.sessionTitle.maxWords, 7);
  assert.ok(loaded.warnings.some((warning) => warning.includes("sessionTitle.maxWords")));
  assert.deepEqual(loaded.config.compaction, {
    enabled: true,
    thresholdPercent: 90,
  });
  assert.ok(loaded.warnings.some((warning) => warning.includes("notifications.reviewFailure")));
  assert.ok(loaded.warnings.some((warning) => warning.includes("compaction.enabled")));
  assert.ok(loaded.warnings.some((warning) => warning.includes("compaction.thresholdPercent")));
  assert.ok(loaded.warnings.some((warning) => warning.includes("Unknown top-level key")));
});

test("invalid JSON produces a warning and safe defaults", () => {
  const paths = fixture();
  writeFileSync(join(paths.agentDir, "pi-tai.json"), "{");
  const loaded = loadPiTaiConfig({ ...paths, projectTrusted: false });
  assert.equal(loaded.config.sessionTitle.maxWords, 6);
  assert.equal(loaded.warnings.length, 1);
});
