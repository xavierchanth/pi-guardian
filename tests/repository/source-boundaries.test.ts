import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const packageRoot = join(root, "packages/pi-tai");

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)
        ? [path]
        : [];
  });
}

test("core never imports terminal", () => {
  const offenders = sourceFiles(join(packageRoot, "src/core")).filter((file) =>
    /(?:from|import\()\s*["'][^"']*terminal(?:\/|["'])/.test(readFileSync(file, "utf8")),
  );
  assert.deepEqual(
    offenders.map((file) => relative(root, file)),
    [],
  );
});

test("external production code uses only the Pi-Tai facades", () => {
  const offenders = ["apps", "bins", "services"].flatMap((directory) =>
    sourceFiles(join(root, directory)).filter((file) =>
      /packages\/pi-tai\/src(?:\/|["'])/.test(readFileSync(file, "utf8")),
    ),
  );
  assert.deepEqual(
    offenders.map((file) => relative(root, file)),
    [],
  );
  const runtime = readFileSync(join(root, "services/pi-runtime/src/pi-runtime.ts"), "utf8");
  assert.match(runtime, /packages\/pi-tai\/pi-tai\.ts/);
  assert.match(runtime, /packages\/pi-tai\/core\.ts/);
});

test("retired feature paths and identifiers remain absent", () => {
  for (const path of ["src/agents", "src/subagents", "src/work-context", "src/session-title"]) {
    assert.equal(existsSync(join(packageRoot, path)), false, path);
  }
  const source = sourceFiles(packageRoot)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  assert.doesNotMatch(source, /SessionCapabilityController|sessionCapabilities|set_capability/);
  assert.doesNotMatch(
    source,
    /register(?:WorkContext|SessionTitle)|work-context\/|session-title\//,
  );
});

test("core, terminal, facades, and subagent resources ship", () => {
  for (const path of [
    "core.ts",
    "pi-tai.ts",
    "src/core/subagents/register.ts",
    "src/core/subagents/models.json",
    "src/core/subagents/capabilities.json",
    "src/core/subagents/capabilities/researcher.md",
    "src/terminal/footer/register.ts",
    "src/terminal/notifications/register.ts",
  ])
    assert.ok(existsSync(join(packageRoot, path)), path);
});
