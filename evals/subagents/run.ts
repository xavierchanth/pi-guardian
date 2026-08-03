#!/usr/bin/env -S node --experimental-strip-types
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases, type SubagentCase } from "../shared/cases.ts";

type Result = {
  caseId: string;
  title: string;
  execution: "specification-only";
  status: "skipped";
  reason: string;
};
async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const cases = (await loadCases(join(here, "cases"), "subagents")) as SubagentCase[];
  const results: Result[] = cases.map((spec) => ({
    caseId: spec.id,
    title: spec.title,
    execution: spec.execution,
    status: "skipped",
    reason: "Specification-only: protocol execution is not implemented in this eval slice.",
  }));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportDir = join(here, "reports", stamp);
  const report = {
    schemaVersion: 1,
    suite: "subagents",
    mode: "validation-only",
    createdAt: new Date().toISOString(),
    summary: { passed: 0, failed: 0, skipped: results.length, total: results.length },
    results,
  };
  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const rows = results.map((r) => `| SKIPPED | ${r.caseId} | ${r.reason} |`).join("\n");
  await writeFile(
    join(reportDir, "summary.md"),
    `# Subagent lifecycle specification validation\n\nValidation only; no protocol scenarios were executed.\n\n0 passed, 0 failed, ${results.length} skipped.\n\n| Status | Case | Reason |\n|---|---|---|\n${rows}\n`,
  );
  console.log(
    `Validated ${results.length} cases: 0 passed, 0 failed, ${results.length} skipped; report: ${reportDir}`,
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
