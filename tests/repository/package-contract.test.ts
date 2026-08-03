import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  keywords?: string[];
  pi?: { extensions?: string[]; prompts?: string[]; themes?: string[]; skills?: string[] };
  dependencies?: Record<string, string>;
  files?: string[];
};

test("root manifest is a discoverable Pi package", () => {
  assert.ok(manifest.keywords?.includes("pi-package"));
  assert.deepEqual(manifest.pi?.extensions, ["./packages/pi-tai/pi-tai.ts"]);
  assert.deepEqual(manifest.pi?.themes, ["./packages/pi-tai/themes"]);
  assert.deepEqual(manifest.pi?.prompts, ["./packages/pi-tai/prompts"]);
  assert.deepEqual(manifest.pi?.skills, ["./packages/pi-tai/skills"]);

  for (const resource of [
    ...(manifest.pi?.extensions ?? []),
    ...(manifest.pi?.themes ?? []),
    ...(manifest.pi?.prompts ?? []),
    ...(manifest.pi?.skills ?? []),
  ]) {
    assert.ok(readFileOrDirectoryExists(join(root, resource)), resource);
  }
});

test("source uses the current Pi distribution imports", () => {
  const files = walkSource(join(root, "packages"));
  const legacy = files.filter((file) => readFileSync(file, "utf8").includes("@mariozechner/"));
  assert.deepEqual(legacy, []);
});

test("the legacy session capability controller is absent from the package", () => {
  assert.equal(existsSync(join(root, "packages/pi-tai/src/capabilities")), false);
  const source = walkSource(join(root, "packages/pi-tai"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  assert.doesNotMatch(source, /SessionCapabilityController|sessionCapabilities|set_capability/);
  assert.doesNotMatch(source, /registerCommand\(["']capabilities["']/);
});

test("Pi-Tai packages a global instruction layer and the DPIC workflow", () => {
  const instructions = readFileSync(join(root, "packages/pi-tai/instructions/system.md"), "utf8");
  assert.ok(instructions.trim().length > 0);
  assert.match(instructions, /Do not reiterate subagent output the user can already see/);
  // Roles are retired: a subagent is described by its objective and isolation,
  // so there are no agent definition files to ship.
  assert.equal(existsSync(join(root, "packages/pi-tai/agents/worker.md")), false);
  assert.equal(existsSync(join(root, "packages/pi-tai/agents/orchestrator.md")), false);

  // The workflow itself lives in the dpic skill; the prompt is a thin entry point
  // that carries the work description and delegates to it.
  const prompt = readFileSync(join(root, "packages/pi-tai/prompts/dpic.md"), "utf8");
  assert.match(prompt, /argument-hint: "\[work description\]"/);
  assert.match(prompt, /\$\{ARGUMENTS:-/);
  assert.match(prompt, /Load and follow the `dpic` skill/);
  assert.doesNotMatch(prompt, /subagent_spawn/);

  const dpic = readFileSync(join(root, "packages/pi-tai/skills/dpic/SKILL.md"), "utf8");
  assert.match(dpic, /name: dpic/);
  assert.match(dpic, /subagent_spawn/);
  assert.match(dpic, /isolation: "workspace"/);
  assert.match(dpic, /`continue` naming the finished subagent/);
  assert.match(dpic, /shared index, manifest, README table, or numbered list/);
  assert.match(dpic, /Delegation is not completion|Delegating is not finishing/);
});

test("checkpoint prompt accepts additional instructions", () => {
  const prompt = readFileSync(join(root, "packages/pi-tai/prompts/checkpoint.md"), "utf8");
  assert.match(prompt, /argument-hint: "\[additional instructions\]"/);
  assert.match(prompt, /## Additional instructions/);
  assert.match(prompt, /\$\{ARGUMENTS:-No additional instructions were provided\.\}/);
  assert.match(prompt, /without weakening the safety requirements above/);
});

test("the subagent tool surface is the nine-tool set", () => {
  const source = readFileSync(join(root, "packages/pi-tai/src/core/subagents/register.ts"), "utf8");
  const registered = [...source.matchAll(/name: "([a-z_]+)",\n\s+label:/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(registered, [
    "subagent_cancel",
    "subagent_check",
    "subagent_list",
    "subagent_send",
    "subagent_spawn",
    "subagent_wait",
    "workspace_discard",
    "workspace_merge",
    "workspace_status",
  ]);
  assert.equal(
    existsSync(join(root, "packages/pi-tai/src/subagents/register.ts")),
    false,
    "the retired 47-tool registrar is gone",
  );
});

test("the packaged capability catalog and instruction assets agree", () => {
  const catalog = JSON.parse(
    readFileSync(join(root, "packages/pi-tai/src/core/subagents/capabilities.json"), "utf8"),
  ) as { version?: number; capabilities?: Array<{ name?: string; instructions?: string }> };
  assert.equal(catalog.version, 1);
  assert.deepEqual(
    catalog.capabilities?.map((entry) => entry.name),
    ["researcher"],
  );
  for (const capability of catalog.capabilities ?? []) {
    assert.ok(capability.instructions, `${capability.name} names an instruction asset`);
    assert.ok(
      existsSync(
        join(root, "packages/pi-tai/src/core/subagents/capabilities", capability.instructions!),
      ),
    );
  }
});

test("the packaged model catalog declares every supported alias", () => {
  const catalog = JSON.parse(
    readFileSync(join(root, "packages/pi-tai/src/core/subagents/models.json"), "utf8"),
  ) as { version?: number; aliases?: Array<{ name?: string }> };
  assert.equal(catalog.version, 1);
  assert.deepEqual(catalog.aliases?.map((entry) => entry.name).sort(), [
    "fable",
    "glm",
    "kimi",
    "luna",
    "opus",
    "sol",
    "sonnet",
    "terra",
  ]);
});

test("version-control and invariant modeling skills are packaged", () => {
  const skills = join(root, "packages/pi-tai/skills");
  const jj = readFileSync(join(skills, "jj-guidelines/SKILL.md"), "utf8");
  assert.match(jj, /name: jj-guidelines/);
  assert.match(jj, /Prefer jj over git whenever a \.jj directory is present/);
  assert.match(jj, /Use Conventional Commits/);

  const invariants = readFileSync(join(skills, "invariants/SKILL.md"), "utf8");
  assert.match(invariants, /name: invariants/);
  assert.doesNotMatch(invariants, /name: model-invariants/);
  assert.match(invariants, /make invalid states unrepresentable/);
  assert.match(invariants, /Keep one representation per fact/);
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

test("runtime protocol ships Rust-first DTOs and checked-in TypeScript bindings", () => {
  assert.ok(existsSync(join(root, "crates/runtime-protocol/src/lib.rs")));
  const generated = readFileSync(join(root, "packages/runtime-protocol/src/generated.ts"), "utf8");
  assert.match(generated, /@generated by pi-tai-runtime-protocol/);
  assert.match(generated, /export type RuntimeCommand/);
  assert.ok(existsSync(join(root, "packages/runtime-protocol/src/schemas.ts")));
});

test("portable Host crates remain independent of Tauri", () => {
  for (const crate of [
    "broker",
    "event-store",
    "host-kernel",
    "host-lifecycle",
    "host-platform",
    "host-protocol",
    "host-server",
    "local-ipc",
    "runtime-supervisor",
  ]) {
    const cargo = readFileSync(join(root, `crates/${crate}/Cargo.toml`), "utf8");
    assert.doesNotMatch(cargo, /tauri/i, crate);
  }
  const shellCargo = readFileSync(join(root, "apps/host/src-tauri/Cargo.toml"), "utf8");
  assert.match(shellCargo, /tauri/);
  assert.ok(existsSync(join(root, "packages/host-protocol/src/index.ts")));
  assert.ok(existsSync(join(root, "fixtures/host-protocol/command-prompt.json")));
});

test("desktop manager uses Tauri 2, Vite, React Compiler, and Tailwind", () => {
  const desktop = JSON.parse(readFileSync(join(root, "apps/host/package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const vite = readFileSync(join(root, "apps/host/vite.config.ts"), "utf8");
  const tauri = readFileSync(join(root, "apps/host/src-tauri/Cargo.toml"), "utf8");

  assert.equal(desktop.dependencies?.react, "19.2.8");
  assert.ok(desktop.devDependencies?.["babel-plugin-react-compiler"]);
  assert.ok(desktop.devDependencies?.tailwindcss);
  assert.match(vite, /reactCompilerPreset/);
  assert.match(vite, /tailwindcss\(\)/);
  assert.match(tauri, /tauri = \{ version = "2"/);
});

test("package ships standalone Guardian and required support files", () => {
  assert.equal(manifest.dependencies?.["pi-approval-guardian"], undefined);
  assert.ok(existsSync(join(root, "packages/pi-tai/src/core/guardian/reviewer.ts")));
  assert.ok(manifest.files?.includes("justfile"));
  assert.ok(existsSync(join(root, "justfile")));
  assert.doesNotMatch(readFileSync(join(root, "README.md"), "utf8"), /TEMPORARY/);
});

test("package composes only the reporting-only pi-cmux modules", () => {
  assert.equal(manifest.dependencies?.["pi-cmux"], "^0.1.16");
  assert.equal(manifest.dependencies?.jiti, "^2.7.0");
  const source = walkSource(join(root, "packages/pi-tai"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const imports = [...source.matchAll(/pi-cmux\/extensions\/([^"']+)/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(imports, ["cmux-notify.ts", "cmux-sidebar.ts", "i18n.ts"]);
  for (const excluded of [
    "index",
    "cmux-review",
    "cmux-continue",
    "cmux-split",
    "cmux-open",
    "cmux-zoxide",
  ]) {
    assert.doesNotMatch(source, new RegExp(`pi-cmux/extensions/${excluded}(?:\\.ts)?["']`));
  }
});

test("package omits retired direct web tools and dependencies", () => {
  assert.equal(manifest.dependencies?.["html-to-text"], undefined);
  assert.equal(manifest.dependencies?.["ipaddr.js"], undefined);
  assert.equal(existsSync(join(root, "packages/pi-tai/src/web")), false);
  assert.equal(existsSync(join(root, "packages/pi-tai/subagent.ts")), false);
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
