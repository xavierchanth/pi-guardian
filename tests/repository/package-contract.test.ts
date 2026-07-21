import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  keywords?: string[];
  pi?: { extensions?: string[]; prompts?: string[]; themes?: string[] };
  dependencies?: Record<string, string>;
  files?: string[];
};

test("root manifest is a discoverable Pi package", () => {
  assert.ok(manifest.keywords?.includes("pi-package"));
  assert.deepEqual(manifest.pi?.extensions, ["./packages/pi-tai/pi-tai.ts"]);
  assert.deepEqual(manifest.pi?.themes, ["./packages/pi-tai/themes"]);
  assert.deepEqual(manifest.pi?.prompts, ["./packages/pi-tai/prompts"]);

  for (const resource of [
    ...(manifest.pi?.extensions ?? []),
    ...(manifest.pi?.themes ?? []),
    ...(manifest.pi?.prompts ?? []),
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

test("Pi-Tai packages user-authored system and role instruction files", () => {
  for (const name of ["system.md", "parent.md", "child.md"]) {
    const path = join(root, "packages/pi-tai/instructions", name);
    assert.ok(existsSync(path), path);
    assert.equal(readFileSync(path, "utf8"), "", `${name} starts user-authored and empty`);
  }
});

test("continue is packaged as a visible prompt template", () => {
  const prompt = readFileSync(join(root, "packages/pi-tai/prompts/continue.md"), "utf8");
  assert.match(prompt, /description: Continue the agent's previous work/);
  assert.match(prompt, /Continue what you were doing\./);
  assert.doesNotMatch(
    walkSource(join(root, "packages")).map((file) => readFileSync(file, "utf8")).join("\n"),
    /registerCommand\(["']continue["']/,
  );
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

test("portable Host crates remain independent of Tauri", () => {
  for (const crate of ["host-protocol", "host-lifecycle", "host-platform"]) {
    const cargo = readFileSync(join(root, `crates/${crate}/Cargo.toml`), "utf8");
    assert.doesNotMatch(cargo, /tauri/i, crate);
  }
  const shellCargo = readFileSync(join(root, "apps/host/src-tauri/Cargo.toml"), "utf8");
  assert.match(shellCargo, /tauri/);
  assert.ok(existsSync(join(root, "packages/host-protocol/src/index.ts")));
  assert.ok(existsSync(join(root, "fixtures/host-protocol/command-prompt.json")));
});

test("package ships standalone Guardian and required support files", () => {
  assert.equal(manifest.dependencies?.["pi-approval-guardian"], undefined);
  assert.ok(existsSync(join(root, "packages/pi-tai/src/guardian/reviewer.ts")));
  assert.ok(manifest.files?.includes("justfile"));
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
