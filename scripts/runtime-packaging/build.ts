import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const outputRoot = resolve(root, process.env.PI_TAI_RUNTIME_ARTIFACT_DIR ?? "dist/runtime-packaging");
const requiredBunVersion = "1.3.14";
const requiredNodeVersion = "v24.18.0";
const bunVersion = (await execFileAsync("bun", ["--version"], { cwd: root })).stdout.trim();
if (bunVersion !== requiredBunVersion || process.version !== requiredNodeVersion) {
  throw new Error(
    `Runtime packaging requires Bun ${requiredBunVersion} and Node ${requiredNodeVersion}; got Bun ${bunVersion} and Node ${process.version}.`,
  );
}
const requested = process.argv[2] ?? "all";
const candidates = requested === "all" ? ["bun", "sea", "sidecar"] : [requested];

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
const results: Array<Record<string, unknown>> = [];
for (const candidate of candidates) {
  try {
    results.push(await build(candidate));
  } catch (error) {
    results.push({
      candidate,
      build: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
await writeFile(join(outputRoot, "build-results.json"), `${JSON.stringify(results, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
const required = requested === "all" ? results.find((result) => result.candidate === "bun") : results[0];
if (!required || required.build !== "passed") process.exitCode = 1;

async function build(candidate: string): Promise<Record<string, unknown>> {
  switch (candidate) {
    case "bun": return buildBun();
    case "sidecar": return buildSidecar();
    case "sea": return buildSea();
    default: throw new Error(`Unknown packaging candidate: ${candidate}`);
  }
}

async function buildBun(): Promise<Record<string, unknown>> {
  const directory = join(outputRoot, "bun");
  const executable = join(directory, "pi-tai-runtime");
  await mkdir(directory, { recursive: true });
  await run("bun", ["build", "services/pi-runtime/src/bootstrap.ts", "--compile", "--outfile", executable]);
  return descriptor("bun", executable, [], [executable]);
}

async function buildSidecar(): Promise<Record<string, unknown>> {
  const directory = join(outputRoot, "sidecar");
  const executable = join(directory, "node");
  const bundle = join(directory, "runtime.mjs");
  await mkdir(directory, { recursive: true });
  await run("bun", [
    "build", "services/pi-runtime/src/bootstrap.ts", "--target=node", "--format=esm", "--outfile", bundle,
  ]);
  await copyFile(process.execPath, executable);
  return descriptor("sidecar", executable, [bundle], [executable, bundle]);
}

async function buildSea(): Promise<Record<string, unknown>> {
  const directory = join(outputRoot, "sea");
  const executable = join(directory, "pi-tai-runtime");
  const bundle = join(directory, "runtime.cjs");
  const blob = join(directory, "sea-prep.blob");
  const config = join(directory, "sea-config.json");
  await mkdir(directory, { recursive: true });
  await run("bun", [
    "build", "services/pi-runtime/src/bootstrap.ts", "--target=node", "--format=cjs", "--outfile", bundle,
  ]);
  await writeFile(config, JSON.stringify({
    main: bundle,
    output: blob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  }));
  await run(process.execPath, ["--experimental-sea-config", config]);
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o755);
  if (process.platform === "darwin") await run("codesign", ["--remove-signature", executable], true);
  await run(resolve(root, "node_modules/.bin/postject"), [
    executable,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ]);
  if (process.platform === "darwin") await run("codesign", ["--sign", "-", executable]);
  return descriptor("sea", executable, [], [executable]);
}

async function descriptor(candidate: string, executable: string, args: string[], files: string[]) {
  const sizes = await Promise.all(files.map(async (file) => (await stat(file)).size));
  return {
    candidate,
    build: "passed",
    executable,
    args,
    artifactBytes: sizes.reduce((total, size) => total + size, 0),
    nodeVersion: process.version,
    bunVersion,
  };
}

async function run(command: string, args: string[], allowFailure = false): Promise<void> {
  try {
    await execFileAsync(command, args, { cwd: root, maxBuffer: 20 * 1024 * 1024 });
  } catch (error) {
    if (allowFailure) return;
    const detail = error as Error & { stderr?: string; stdout?: string };
    throw new Error(`${command} failed: ${detail.stderr || detail.stdout || detail.message}`);
  }
}
