import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPiTaiConfig } from "../../packages/pi-tai/src/core/config/load.ts";

const corpusRoot = join(import.meta.dirname, "../../fixtures/config");

for (const name of readdirSync(corpusRoot).sort()) {
  test(`TypeScript config resolver matches fixture: ${name}`, () => {
    const fixture = join(corpusRoot, name);
    const metadata = JSON.parse(readFileSync(join(fixture, "metadata.json"), "utf8"));
    const root = mkdtempSync(join(tmpdir(), "pi-tai-config-differential-"));
    try {
      const agentDir = join(root, "agent");
      const cwd = join(root, "project");
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      mkdirSync(agentDir, { recursive: true });
      copyIfPresent(join(fixture, "global.json"), join(agentDir, "pi-tai.json"));
      copyIfPresent(join(fixture, "project.json"), join(cwd, ".pi", "pi-tai.json"));

      const loaded = loadPiTaiConfig({ agentDir, cwd, projectTrusted: metadata.projectTrusted });
      const actual = {
        config: loaded.config,
        provenance: Object.fromEntries(
          Object.entries(loaded.provenance).map(([path, origin]) => [
            path,
            origin.path
              ? { ...origin, path: origin.layer === "project" ? "project.json" : "global.json" }
              : origin,
          ]),
        ),
        warnings: loaded.warnings.map((warning) =>
          warning
            .replaceAll(loaded.globalPath, "global.json")
            .replaceAll(loaded.projectPath, "project.json"),
        ),
      };
      assert.deepEqual(actual, JSON.parse(readFileSync(join(fixture, "expected.json"), "utf8")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

function copyIfPresent(source: string, destination: string): void {
  if (existsSync(source)) cpSync(source, destination);
}
