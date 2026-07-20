import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  keywords?: string[];
  pi?: { extensions?: string[]; themes?: string[] };
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

function readFileOrDirectoryExists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EISDIR";
  }
}

function walkSource(directory: string): string[] {
  const { readdirSync } = requireFs();
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walkSource(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function requireFs(): typeof import("node:fs") {
  return process.getBuiltinModule("node:fs")!;
}
