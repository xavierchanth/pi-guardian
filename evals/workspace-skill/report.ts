import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Check, Trace } from "./assertions.ts";
import type { EvalCase } from "./cases.ts";
import type { Fixture } from "./fixtures.ts";
export type CaseResult={caseId:string;title:string;trial:number;seed:string;dryRun:boolean;status:"passed"|"failed"|"skipped";passed:boolean;startedAt:string;finishedAt:string;durationMs:number;fixturePath:string;retained:boolean;fixtureManifest:Fixture["manifest"];checks:Check[];commands:string[];trace:Trace["records"];stdout:string;stderr:string;finalOutput:string|null;usage:unknown|null;observedModel:Trace["observedModel"];error:string|null};
export type Report={schemaVersion:1;runId:string;startedAt:string;finishedAt:string;seed:string;trials:number;dryRun:boolean;model:{provider:string|null;model:string|null;thinking:string|null};environment:{node:string;platform:string;cwd:string;distribution:string;skill:string;skillHash:string;piCommand:string[];versions:{pi:string|null;jj:string|null;git:string|null}};summary:{passed:number;failed:number;skipped:number;total:number};results:CaseResult[]};
export function caseResult(spec:EvalCase,fixture:Fixture,trial:number,seed:string,dryRun:boolean,startedAt:string,finishedAt:string,durationMs:number,checks:Check[],trace:Trace,error?:string):CaseResult{
  const checksPass=checks.every(c=>c.passed),status=spec.execution==="specification-only"?"skipped":!error&&checksPass?"passed":"failed";return {caseId:spec.id,title:spec.title,trial,seed,dryRun,status,passed:status==="passed",startedAt,finishedAt,durationMs,fixturePath:fixture.root,retained:status==="failed",fixtureManifest:fixture.manifest,checks,commands:trace.commands,trace:trace.records,stdout:trace.stdout,stderr:trace.stderr,finalOutput:trace.finalOutput,usage:trace.usage,observedModel:trace.observedModel,error:error??null};
}
export async function writeReport(dir:string,report:Report):Promise<void>{
  await mkdir(join(dir,"cases"),{recursive:true});const json=JSON.stringify(report,null,2);await writeFile(join(dir,"results.json"),json);await writeFile(join(dir,"report.json"),json);
  const rows=report.results.map(r=>`| ${r.status.toUpperCase()} | ${r.caseId} | ${r.trial} | ${r.seed} | ${r.durationMs} | ${r.retained?r.fixturePath:"removed"} |`).join("\n");
  await writeFile(join(dir,"summary.md"),`# Workspace skill evaluation\n\nRun: \`${report.runId}\`  \nSeed: \`${report.seed}\`  \nDry run: ${report.dryRun}  \nSkill hash: \`${report.environment.skillHash}\`\n\n${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped (${report.summary.total} total).\n\n| Result | Case | Trial | Seed | ms | Fixture disposition |\n|---|---|---:|---|---:|---|\n${rows}\n`);
  for(const result of report.results)await writeFile(join(dir,"cases",`${result.caseId}-${result.trial}.json`),JSON.stringify(result,null,2));
  const lines=report.results.flatMap(r=>r.trace.map(record=>JSON.stringify({caseId:r.caseId,trial:r.trial,seed:r.seed,...record})));await writeFile(join(dir,"commands.jsonl"),lines.length?`${lines.join("\n")}\n`:"");
}
