import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { RuntimeProcessHarness, initializeParams } from "../../tests/runtime/process-harness.ts";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const artifactRoot = resolve(
  root,
  process.env.PI_TAI_RUNTIME_ARTIFACT_DIR ?? "dist/runtime-packaging",
);
const buildResults = JSON.parse(
  await readFile(join(artifactRoot, "build-results.json"), "utf8"),
) as BuildResult[];
const requested = process.argv[2] ?? "all";
const selected = buildResults.filter(
  (entry) => entry.build === "passed" && (requested === "all" || entry.candidate === requested),
);
const results: CandidateResult[] = [];
for (const candidate of selected) {
  const workers = new Set<RuntimeProcessHarness>();
  try {
    results.push(await smoke(candidate, workers));
  } catch (error) {
    results.push({
      candidate: candidate.candidate,
      smoke: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    for (const worker of workers) worker.child.kill("SIGKILL");
  }
}
for (const failed of buildResults.filter(
  (entry) => entry.build !== "passed" && (requested === "all" || entry.candidate === requested),
)) {
  results.push({ candidate: failed.candidate, smoke: "not_run", error: failed.error });
}
await writeFile(join(artifactRoot, "smoke-results.json"), `${JSON.stringify(results, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
const required =
  requested === "all" ? results.find((result) => result.candidate === "bun") : results[0];
if (!required || required.smoke !== "passed") process.exitCode = 1;

interface BuildResult {
  candidate: string;
  build: "passed" | "failed";
  executable?: string;
  args?: string[];
  artifactBytes?: number;
  error?: string;
}
interface CandidateResult {
  candidate: string;
  smoke: "passed" | "failed" | "not_run";
  readinessMedianMs?: number;
  readinessP95Ms?: number;
  idleRssKiB?: number;
  activeRssKiB?: number;
  artifactBytes?: number;
  error?: string;
}

async function smoke(
  candidate: BuildResult,
  workers: Set<RuntimeProcessHarness>,
): Promise<CandidateResult> {
  if (!candidate.executable) throw new Error("candidate executable is missing");
  const isolated = await mkdtemp(join(tmpdir(), `pi-runtime-${candidate.candidate}-`));
  const artifactDir = join(isolated, "artifact");
  const cwd = join(isolated, "workspace");
  const agentDir = join(isolated, "agent");
  const sessionDir = join(isolated, "sessions");
  await Promise.all([mkdir(artifactDir), mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
  const executable = join(artifactDir, basename(candidate.executable));
  await copyFile(candidate.executable, executable);
  await chmod(executable, 0o755);
  const args: string[] = [];
  for (const source of candidate.args ?? []) {
    const target = join(artifactDir, basename(source));
    await copyFile(source, target);
    args.push(target);
  }
  const env = {
    HOME: isolated,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PATH: "/usr/bin:/bin",
  };

  const readiness: number[] = [];
  for (let index = 0; index < 10; index++) {
    const started = performance.now();
    const worker = new RuntimeProcessHarness({ executable, args, cwd: isolated, env });
    workers.add(worker);
    const initialized = await worker.command(
      `init-${index}`,
      "runtime.initialize",
      initializeParams(index + 1),
    );
    if (!initialized.ok) throw new Error(`initialization failed: ${JSON.stringify(initialized)}`);
    readiness.push(performance.now() - started);
    await worker.command(`shutdown-${index}`, "runtime.shutdown", {});
    await worker.waitForExit();
  }

  const worker = new RuntimeProcessHarness({ executable, args, cwd: isolated, env });
  workers.add(worker);
  await worker.command("init", "runtime.initialize", initializeParams(20));
  const created = await worker.command("create", "session.create", {
    cwd,
    agentDir,
    sessionDir,
    faux: true,
  });
  if (!created.ok) throw new Error(`session.create failed: ${JSON.stringify(created)}`);
  const sessionReady = await worker.waitFor((frame) => frame.event === "session.ready");
  if (!sessionReady.data.capabilities.tools.includes("update_plan"))
    throw new Error("Pi-Tai update_plan tool missing");
  if (!sessionReady.data.capabilities.commands.includes("continue"))
    throw new Error("Pi-Tai continue command missing");
  if (sessionReady.data.capabilities.extensionErrors.length > 0) {
    throw new Error(
      `Pi-Tai extension errors: ${JSON.stringify(sessionReady.data.capabilities.extensionErrors)}`,
    );
  }
  const sessionFile = created.result.sessionFile as string;
  const sessionId = created.result.sessionId as string;
  const idleRssKiB = await rss(worker.child.pid);
  await worker.command("plan", "session.prompt", { turnId: "turn-plan", text: "use update_plan" });
  await worker.waitFor((frame) => frame.event === "session.idle" && frame.turnId === "turn-plan");
  if (
    !worker.frames.some(
      (frame) => frame.event === "tool.end" && frame.data.toolName === "update_plan",
    )
  ) {
    throw new Error("packaged Pi-Tai update_plan execution missing");
  }
  await worker.command("persist", "session.prompt", {
    turnId: "turn-persist",
    text: "first persisted turn",
  });
  await worker.waitFor(
    (frame) => frame.event === "session.idle" && frame.turnId === "turn-persist",
  );
  await worker.command("slow", "session.prompt", { turnId: "turn-slow", text: "slow response" });
  await worker.waitFor(
    (frame) => frame.event === "assistant.text_delta" && frame.turnId === "turn-slow",
  );
  const activeRssKiB = await rss(worker.child.pid);
  await worker.command("cancel", "session.cancel", { turnId: "turn-slow" });
  await worker.waitFor(
    (frame) => frame.event === "session.interrupted" && frame.turnId === "turn-slow",
  );
  await worker.waitFor((frame) => frame.event === "session.idle" && frame.turnId === "turn-slow");
  await worker.command("shutdown", "runtime.shutdown", {});
  await worker.waitForExit();

  const reopened = new RuntimeProcessHarness({ executable, args, cwd: isolated, env });
  workers.add(reopened);
  await reopened.command("reinit", "runtime.initialize", initializeParams(21));
  const opened = await reopened.command("open", "session.open", {
    sessionFile,
    agentDir,
    sessionDir,
    faux: true,
  });
  if (opened.result.sessionId !== sessionId)
    throw new Error("packaged worker did not reopen the same Pi session");
  await reopened.command("history", "session.prompt", {
    turnId: "turn-history",
    text: "verify history",
  });
  await reopened.waitFor(
    (frame) => frame.event === "session.idle" && frame.turnId === "turn-history",
  );
  const restoredText = reopened.frames
    .filter((frame) => frame.event === "assistant.text_delta" && frame.turnId === "turn-history")
    .map((frame) => frame.data.delta)
    .join("");
  if (!restoredText.includes("history-present"))
    throw new Error("reopened history was not restored");
  await reopened.command("signal-turn", "session.prompt", {
    turnId: "turn-signal",
    text: "slow response",
  });
  await reopened.waitFor(
    (frame) => frame.event === "assistant.text_delta" && frame.turnId === "turn-signal",
  );
  reopened.child.kill("SIGTERM");
  await reopened.waitForExit();
  if (
    !reopened.frames.some(
      (frame) => frame.event === "session.interrupted" && frame.turnId === "turn-signal",
    )
  ) {
    throw new Error("signal shutdown did not emit interruption");
  }
  const diagnostics = `${worker.stderr}\n${reopened.stderr}`;
  if (
    ["use update_plan", "slow response", "first persisted turn", "verify history"].some((prompt) =>
      diagnostics.includes(prompt),
    )
  ) {
    throw new Error("diagnostics leaked prompt content");
  }
  if (!sessionFile.startsWith(isolated)) throw new Error("session escaped isolated root");
  for (const line of (await readFile(sessionFile, "utf8")).trim().split("\n")) JSON.parse(line);

  readiness.sort((a, b) => a - b);
  return {
    candidate: candidate.candidate,
    smoke: "passed",
    readinessMedianMs: round(percentile(readiness, 0.5)),
    readinessP95Ms: round(percentile(readiness, 0.95)),
    idleRssKiB,
    activeRssKiB,
    artifactBytes: candidate.artifactBytes,
  };
}

async function rss(pid: number | undefined): Promise<number> {
  if (!pid) return 0;
  const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
  return Number.parseInt(stdout.trim(), 10) || 0;
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}
function round(value: number): number {
  return Math.round(value * 10) / 10;
}
