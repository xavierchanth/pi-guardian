import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPiTaiConfig } from "../../packages/pi-tai/src/core/config/load.ts";
import { FIELD_DESCRIPTORS } from "../../packages/pi-tai/src/core/config/provenance.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-tai-config-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  return { agentDir, cwd };
}

test("trusted projects cannot replace privileged model profiles", () => {
  const paths = fixture();
  writeFileSync(
    join(paths.agentDir, "pi-tai.json"),
    JSON.stringify({
      modelProfiles: [
        { name: "global-low", provider: "openai-codex", model: "global", effort: "low" },
      ],
    }),
  );
  writeFileSync(
    join(paths.cwd, ".pi", "pi-tai.json"),
    JSON.stringify({
      modelProfiles: [
        { name: "project-high", provider: "openai-codex", model: "project", effort: "high" },
        { name: "project-low", provider: "openai-codex", model: "project", effort: "low" },
      ],
    }),
  );
  const trusted = loadPiTaiConfig({ ...paths, projectTrusted: true });
  assert.deepEqual(
    trusted.config.sessionPolicy.modelProfiles.map((profile) => profile.name),
    ["global-low"],
  );
  assert.ok(trusted.warnings.some((warning) => warning.includes("sessionPolicy.modelProfiles")));
  const untrusted = loadPiTaiConfig({ ...paths, projectTrusted: false });
  assert.deepEqual(
    untrusted.config.sessionPolicy.modelProfiles.map((profile) => profile.name),
    ["global-low"],
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
  writeFileSync(
    join(paths.agentDir, "pi-tai.json"),
    JSON.stringify({
      compaction: { enabled: false },
    }),
  );
  writeFileSync(
    join(paths.cwd, ".pi", "pi-tai.json"),
    JSON.stringify({
      compaction: { thresholdPercent: 75 },
    }),
  );

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
  assert.match(
    loaded.provenance["sessionPolicy.compaction.enabled"]?.digest ?? "",
    /^[a-f0-9]{64}$/,
  );
  assert.match(
    loaded.provenance["sessionPolicy.compaction.thresholdPercent"]?.digest ?? "",
    /^[a-f0-9]{64}$/,
  );
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
