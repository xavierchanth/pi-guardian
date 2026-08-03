import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../..");
const workflowSource = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const workflow = parse(workflowSource) as {
  jobs?: { check?: { steps?: Array<{ name?: string; run?: string }> } };
};
const steps = workflow.jobs?.check?.steps ?? [];

function namedStep(name: string) {
  const step = steps.find((candidate) => candidate.name === name);
  assert.ok(step, `CI step ${JSON.stringify(name)} must exist`);
  return step;
}

test("CI installs the Rust checks on the Cargo.toml toolchain", () => {
  const versions = namedStep("Read toolchain versions").run ?? "";
  assert.match(versions, /rust-version =/);

  const install = namedStep("Install pinned Rust toolchain").run ?? "";
  assert.match(install, /toolchain install "\$\{\{ steps\.versions\.outputs\.rust \}\}"/);
  assert.match(install, /--profile minimal/);
  assert.match(install, /--component rustfmt(?:\s|$)/);
  assert.match(install, /--component clippy(?:\s|$)/);
});

test("CI provisions only the native libraries required by the Tauri workspace", () => {
  const install = namedStep("Install Linux desktop build dependencies").run ?? "";
  for (const dependency of [
    "libayatana-appindicator3-dev",
    "librsvg2-dev",
    "libwebkit2gtk-4.1-dev",
  ]) {
    assert.match(install, new RegExp(`\\b${dependency}\\b`));
  }
  assert.match(install, /--no-install-recommends/);
});
