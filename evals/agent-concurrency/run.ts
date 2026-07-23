#!/usr/bin/env -S node --experimental-strip-types
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConcurrencyCases, type ConcurrencyEvalCase } from "./cases.ts";
import { RealJjFixture } from "../../tests/support/real-jj-fixture.ts";

type CaseResult = {
  caseId: string;
  mode: ConcurrencyEvalCase["mode"];
  status: "validated" | "passed" | "failed";
  durationMs: number;
  checks: Array<{ kind: string; value: string; passed: boolean }>;
  error?: string;
};

async function main(): Promise<void> {
  const live = process.argv.slice(2).includes("--live");
  const unknown = process.argv.slice(2).filter((argument) => argument !== "--live");
  if (unknown.length) throw new Error(`Unknown argument: ${unknown.join(" ")}`);
  const here = dirname(fileURLToPath(import.meta.url));
  const distribution = resolve(here, "../..");
  const cases = await loadConcurrencyCases(join(here, "cases"));
  const results: CaseResult[] = [];
  for (const spec of cases) results.push(await executeCase(spec, distribution, live));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportDir = join(here, "reports", stamp);
  const summary = {
    passed: results.filter((item) => item.status === "passed").length,
    failed: results.filter((item) => item.status === "failed").length,
    validated: results.filter((item) => item.status === "validated").length,
    total: results.length,
  };
  const report = {
    schemaVersion: 1,
    suite: "agent-concurrency",
    execution: live ? "opt-in-live" : "validation-only",
    createdAt: new Date().toISOString(),
    command: ["pi", "-ne", "-e", distribution, "<prompt>"],
    summary,
    results,
  };
  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(reportDir, "summary.md"), renderSummary(report.execution, summary, results));
  console.log(`${summary.passed} passed, ${summary.failed} failed, ${summary.validated} validated; report: ${reportDir}`);
  if (summary.failed) process.exitCode = 1;
}

async function executeCase(spec: ConcurrencyEvalCase, distribution: string, live: boolean): Promise<CaseResult> {
  const started = performance.now();
  let fixture: RealJjFixture | undefined;
  try {
    if (spec.mode === "real-jj") {
      fixture = await RealJjFixture.create(`pi-tai-eval-${spec.id}-`);
      const snapshot = await fixture.snapshot();
      if (snapshot.workspaces.length !== 1) throw new Error("Empty Real-JJ fixture did not have exactly one workspace.");
    }
    if (!live) {
      return { caseId: spec.id, mode: spec.mode, status: "validated", durationMs: elapsed(started), checks: [] };
    }
    const cwd = fixture?.repoPath ?? distribution;
    const invocation = await invokePi(cwd, distribution, spec.prompt);
    const trace = `${invocation.stdout}\n${invocation.stderr}`;
    const checks = [
      ...spec.expectedTools.map((tool) => ({ kind: "expected_tool", value: tool, passed: trace.includes(tool) })),
      ...spec.forbiddenTools.map((tool) => ({ kind: "forbidden_tool", value: tool, passed: !trace.includes(tool) })),
      ...spec.expectedReportFields.map((field) => ({ kind: "report_field", value: field, passed: trace.toLowerCase().includes(field.toLowerCase()) })),
      { kind: "process_exit", value: "0", passed: invocation.code === 0 && !invocation.timedOut },
    ];
    return {
      caseId: spec.id,
      mode: spec.mode,
      status: checks.every((check) => check.passed) ? "passed" : "failed",
      durationMs: elapsed(started),
      checks,
      ...(invocation.code === 0 ? {} : { error: invocation.timedOut ? "Pi timed out." : `Pi exited ${invocation.code}.` }),
    };
  } catch (error) {
    return {
      caseId: spec.id,
      mode: spec.mode,
      status: "failed",
      durationMs: elapsed(started),
      checks: [],
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    };
  } finally {
    await fixture?.dispose();
  }
}

function invokePi(
  cwd: string,
  distribution: string,
  prompt: string,
  timeoutMs = 300_000,
): Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn("pi", ["-ne", "--mode", "json", "--print", "-e", distribution, prompt], {
      cwd,
      env: process.env,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      stderr += `${error.stack ?? error.message}\n`;
      finish(1);
    });
    child.once("close", (code) => finish(code ?? 1));
    function finish(code: number): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code, timedOut });
    }
  });
}

function renderSummary(
  execution: string,
  summary: { passed: number; failed: number; validated: number; total: number },
  results: CaseResult[],
): string {
  const rows = results.map((item) => `| ${item.status.toUpperCase()} | ${item.caseId} | ${item.durationMs.toFixed(0)} ms |`).join("\n");
  return `# Agent concurrency benchmark\n\nExecution: ${execution}. Live-model results are advisory and non-gating.\n\n${summary.passed} passed, ${summary.failed} failed, ${summary.validated} validated, ${summary.total} total.\n\n| Status | Case | Duration |\n|---|---|---:|\n${rows}\n`;
}

function elapsed(started: number): number { return Math.max(0, performance.now() - started); }

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
