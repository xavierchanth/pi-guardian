import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPiTaiConfig } from "../../packages/pi-tai/src/config/load.ts";
import { FIELD_DESCRIPTORS } from "../../packages/pi-tai/src/config/provenance.ts";

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
  assert.equal(loaded.config.sessionPolicy.sessionTitle.effort, "minimal");
  assert.equal(loaded.config.clientPreferences.ansiTheme.darkTheme, "ansi-dark");
  assert.deepEqual(loaded.config.clientPreferences.notifications, {
    reviewFailure: true,
    agentCompletion: true,
  });
  assert.deepEqual(loaded.config.sessionPolicy.compaction, {
    enabled: true,
    thresholdPercent: 90,
  });
  assert.ok(Object.isFrozen(loaded.config));
  assert.deepEqual(loaded.warnings, []);
});

test("unprivileged trusted project values override valid global values", () => {
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
  assert.deepEqual(loaded.config.sessionPolicy.sessionTitle, {
    provider: "global-provider",
    model: "global-model",
    effort: "minimal",
    maxWords: 8,
    fallback: "heuristic",
  });
  assert.equal(loaded.config.clientPreferences.ansiTheme.darkTheme, "global-dark");
  assert.equal(loaded.config.clientPreferences.ansiTheme.lightTheme, "project-light");
  assert.deepEqual(loaded.config.clientPreferences.notifications, {
    reviewFailure: false,
    agentCompletion: false,
  });
  assert.deepEqual(loaded.config.sessionPolicy.compaction, {
    enabled: false,
    thresholdPercent: 92.5,
  });
  assert.ok(loaded.warnings.some((warning) => warning.includes("sessionPolicy.sessionTitle.model")));
});

test("trusted projects cannot replace privileged model profiles", () => {
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
  assert.deepEqual(trusted.config.sessionPolicy.modelProfiles.map((profile) => profile.name), ["global-low"]);
  assert.ok(trusted.warnings.some((warning) => warning.includes("sessionPolicy.modelProfiles")));
  const untrusted = loadPiTaiConfig({ ...paths, projectTrusted: false });
  assert.deepEqual(untrusted.config.sessionPolicy.modelProfiles.map((profile) => profile.name), ["global-low"]);
});

test("untrusted project configuration is ignored", () => {
  const paths = fixture();
  writeFileSync(join(paths.agentDir, "pi-tai.json"), JSON.stringify({ sessionTitle: { model: "global" } }));
  writeFileSync(join(paths.cwd, ".pi", "pi-tai.json"), JSON.stringify({ sessionTitle: { model: "project" } }));

  const loaded = loadPiTaiConfig({ ...paths, projectTrusted: false });
  assert.equal(loaded.config.sessionPolicy.sessionTitle.model, "global");
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
  assert.equal(loaded.config.sessionPolicy.sessionTitle.provider, "global");
  assert.equal(loaded.config.sessionPolicy.sessionTitle.maxWords, 7);
  assert.ok(loaded.warnings.some((warning) => warning.includes("sessionTitle.maxWords")));
  assert.deepEqual(loaded.config.sessionPolicy.compaction, {
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
  assert.equal(loaded.config.sessionPolicy.sessionTitle.maxWords, 6);
  assert.equal(loaded.warnings.length, 1);
});


test("trusted projects cannot override privileged model selection", () => {
  const paths = fixture();
  writeFileSync(join(paths.agentDir, "pi-tai.json"), JSON.stringify({
    sessionTitle: { model: "global-model" },
    modelProfiles: [
      { name: "global", provider: "openai-codex", model: "global-model", effort: "low" },
    ],
  }));
  writeFileSync(join(paths.cwd, ".pi", "pi-tai.json"), JSON.stringify({
    sessionTitle: { model: "project-model" },
    modelProfiles: [
      { name: "project", provider: "other", model: "project-model", effort: "high" },
    ],
  }));

  const loaded = loadPiTaiConfig({ ...paths, projectTrusted: true });
  assert.equal(loaded.config.sessionPolicy.sessionTitle.model, "global-model");
  assert.equal(loaded.config.sessionPolicy.modelProfiles[0]?.name, "global");
  assert.deepEqual(
    loaded.warnings.filter((warning) => warning.startsWith("Ignored privileged")),
    [
      `Ignored privileged sessionPolicy.sessionTitle.model from ${loaded.projectPath}: privileged fields cannot be set by a project.`,
      `Ignored privileged sessionPolicy.modelProfiles from ${loaded.projectPath}: privileged fields cannot be set by a project.`,
    ],
  );
});

test("provenance is complete and defaults every absent field", () => {
  const loaded = loadPiTaiConfig({ ...fixture(), projectTrusted: false });
  assert.deepEqual(Object.keys(loaded.provenance), Object.keys(FIELD_DESCRIPTORS));
  for (const origin of Object.values(loaded.provenance)) {
    assert.deepEqual(origin, { layer: "default" });
  }
  assert.ok(Object.isFrozen(loaded.provenance));
});

test("provenance identifies winning user and project layers", () => {
  const paths = fixture();
  writeFileSync(join(paths.agentDir, "pi-tai.json"), JSON.stringify({
    compaction: { enabled: false },
  }));
  writeFileSync(join(paths.cwd, ".pi", "pi-tai.json"), JSON.stringify({
    compaction: { thresholdPercent: 75 },
  }));

  const loaded = loadPiTaiConfig({ ...paths, projectTrusted: true });
  assert.deepEqual(loaded.provenance["sessionPolicy.compaction.enabled"], {
    layer: "user",
    path: loaded.globalPath,
    digest: loaded.provenance["sessionPolicy.compaction.enabled"]?.digest,
  });
  assert.deepEqual(loaded.provenance["sessionPolicy.compaction.thresholdPercent"], {
    layer: "project",
    path: loaded.projectPath,
    digest: loaded.provenance["sessionPolicy.compaction.thresholdPercent"]?.digest,
  });
  assert.match(loaded.provenance["sessionPolicy.compaction.enabled"]?.digest ?? "", /^[a-f0-9]{64}$/);
  assert.match(loaded.provenance["sessionPolicy.compaction.thresholdPercent"]?.digest ?? "", /^[a-f0-9]{64}$/);
});

test("layer digests are stable until raw file content changes", () => {
  const paths = fixture();
  const globalPath = join(paths.agentDir, "pi-tai.json");
  writeFileSync(globalPath, '{"compaction":{"enabled":false}}');
  const first = loadPiTaiConfig({ ...paths, projectTrusted: false });
  const second = loadPiTaiConfig({ ...paths, projectTrusted: false });
  const key = "sessionPolicy.compaction.enabled";
  assert.equal(first.provenance[key]?.digest, second.provenance[key]?.digest);

  writeFileSync(globalPath, '{"compaction":{"enabled":false}} ');
  const changed = loadPiTaiConfig({ ...paths, projectTrusted: false });
  assert.notEqual(first.provenance[key]?.digest, changed.provenance[key]?.digest);
});

test("invalid privileged project values warn only about privilege", () => {
  const paths = fixture();
  writeFileSync(join(paths.cwd, ".pi", "pi-tai.json"), JSON.stringify({
    sessionTitle: { model: "" },
  }));
  const loaded = loadPiTaiConfig({ ...paths, projectTrusted: true });
  assert.equal(loaded.warnings.length, 1);
  assert.match(loaded.warnings[0] ?? "", /Ignored privileged sessionPolicy\.sessionTitle\.model/);
});

test("configuration planes partition the documented top-level keys", () => {
  const { config } = loadPiTaiConfig({ ...fixture(), projectTrusted: false });
  const planes = [
    Object.keys(config.sessionPolicy),
    Object.keys(config.clientPreferences),
    Object.keys(config.hostMachine),
  ];
  const allKeys = planes.flat();
  assert.equal(new Set(allKeys).size, allKeys.length);
  assert.deepEqual(
    new Set(allKeys),
    new Set(["sessionTitle", "ansiTheme", "notifications", "compaction", "modelProfiles"]),
  );
});
