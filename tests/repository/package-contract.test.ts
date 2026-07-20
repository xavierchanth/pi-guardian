import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  keywords?: string[];
  pi?: { extensions?: string[]; themes?: string[] };
  dependencies?: Record<string, string>;
  files?: string[];
};

test("root manifest is a discoverable Pi package", () => {
  assert.ok(manifest.keywords?.includes("pi-package"));
  assert.deepEqual(manifest.pi?.extensions, ["./packages/pi-tai/extension.ts"]);
  assert.deepEqual(manifest.pi?.themes, ["./packages/pi-tai/themes"]);

  for (const resource of [
    ...(manifest.pi?.extensions ?? []),
    ...(manifest.pi?.themes ?? []),
  ]) {
    assert.ok(readFileOrDirectoryExists(join(root, resource)), resource);
  }
});

test("source uses the current Pi distribution imports", () => {
  const files = walkSource(join(root, "packages"));
  const legacy = files.filter((file) =>
    readFileSync(file, "utf8").includes("@mariozechner/"),
  );
  assert.deepEqual(legacy, []);
});

test("legacy task blocks and permission modes are absent", () => {
  assert.equal(existsSync(join(root, "packages/pi-tai/src/modes")), false);
  assert.equal(existsSync(join(root, "packages/pi-tai/src/task-context")), false);
  const source = walkSource(join(root, "packages"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  assert.doesNotMatch(source, /```task-context|@mariozechner\/|guardian-prompt\.md/);
  assert.doesNotMatch(source, /registerCommand\(["'](?:mode|review-mode|implement)/);
});

test("package pins Guardian and ships required notices", () => {
  assert.equal(manifest.dependencies?.["pi-approval-guardian"], "0.7.3");
  assert.ok(manifest.files?.includes("THIRD_PARTY_NOTICES.md"));
  assert.ok(manifest.files?.includes("justfile"));
  assert.ok(existsSync(join(root, "THIRD_PARTY_NOTICES.md")));
  assert.ok(existsSync(join(root, "justfile")));
  assert.doesNotMatch(readFileSync(join(root, "README.md"), "utf8"), /TEMPORARY/);
});

function readFileOrDirectoryExists(path: string): boolean {
  return existsSync(path);
}

function walkSource(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walkSource(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}
