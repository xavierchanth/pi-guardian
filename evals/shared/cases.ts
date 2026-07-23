import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

export type Execution = "executable" | "specification-only";
export type WorkspaceSetup =
  | { kind: "jj-repository"; dirty: boolean; completedPlanner?: boolean }
  | { kind: "git-repository"; dirty: boolean; dirtyManagedWorktree?: boolean };
export type WorkspaceInteraction =
  | { kind: "create-workspace"; prompt: string; includeCurrent?: boolean }
  | { kind: "integrate-planner"; prompt: string }
  | { kind: "remove-workspace"; prompt: string };
export type WorkspaceAssertion =
  | { kind: "trace-required"; pattern: string }
  | { kind: "trace-prohibited"; pattern: string }
  | { kind: "workspace-created"; backend: "jj" | "git" }
  | { kind: "dirty-source-excluded" }
  | { kind: "dirty-worktree-recoverable" }
  | { kind: "absolute-path-reported" };
export type WorkspaceCase = { version: 1; suite: "workspace-skill"; id: string; title: string; execution: Execution; setup: WorkspaceSetup; interaction: WorkspaceInteraction; assertions: WorkspaceAssertion[] };

export type SubagentParentRole = "root" | "planner";
export type ChildOutcome = "running" | "completed" | "failed" | "cancelled";
export type SubagentSetup = { kind: "subagent-harness"; parentRole: SubagentParentRole; childRole: "planner" | "worker"; childOutcome: ChildOutcome };
export type SubagentInteraction =
  | { kind: "launch-without-collection"; childCount: number }
  | { kind: "wait-any-collection"; childCount: number }
  | { kind: "question-response-resume"; question: string; response: string }
  | { kind: "rpc-delivery"; delivery: "steer" | "followUp"; message: string }
  | { kind: "interim-status-resume"; role: "planner" | "worker"; parentMessage: string }
  | { kind: "terminal-report"; attemptedReports: number }
  | { kind: "parent-completion"; unresolvedDescendants: number }
  | { kind: "recursive-planner-workspace"; requesterRole: "planner" | "worker" }
  | { kind: "inspect-child-record"; outcome: "failed" | "cancelled" };
export type TranscriptEvent = "parent-steer" | "visible-bounded-status" | "subsequent-work" | "tool-activity" | "terminal-report";
export type SubagentAssertion =
  | { kind: "protocol-invariant"; invariant: "launch-not-completion" | "collect-every-child" | "question-resumes-child" | "delivery-semantics" | "single-terminal-report" | "block-unresolved-parent" | "deny-recursive-planner-workspace" | "terminal-record-inspectable" }
  | { kind: "transcript-sequence"; events: TranscriptEvent[] }
  | { kind: "report-count"; phase: "interim" | "terminal"; count: number };
export type SubagentCase = { version: 1; suite: "subagents"; id: string; title: string; execution: "specification-only"; setup: SubagentSetup; interaction: SubagentInteraction; assertions: SubagentAssertion[] };
export type EvalCase = WorkspaceCase | SubagentCase;

function fail(source: string, path: string, message: string): never { throw new Error(`${source}:${path}: ${message}`); }
function mapping(value: unknown, source: string, path: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail(source, path, "expected mapping"); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, allowed: readonly string[], source: string, path: string): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(source, `${path}.${key}`, "unknown field"); }
function str(value: unknown, source: string, path: string): string { if (typeof value !== "string" || value.length === 0) fail(source, path, "expected non-empty string"); return value; }
function bool(value: unknown, source: string, path: string): boolean { if (typeof value !== "boolean") fail(source, path, "expected boolean"); return value; }
function integer(value: unknown, source: string, path: string): number { if (!Number.isInteger(value) || (value as number) < 0) fail(source, path, "expected non-negative integer"); return value as number; }
function oneOf<T extends string>(value: unknown, choices: readonly T[], source: string, path: string): T { if (typeof value !== "string" || !choices.includes(value as T)) fail(source, path, `expected one of: ${choices.join(", ")}`); return value as T; }
function optionalBool(v: Record<string, unknown>, key: string, source: string, path: string): boolean | undefined { return key in v ? bool(v[key], source, `${path}.${key}`) : undefined; }

function workspaceSetup(raw: unknown, source: string): WorkspaceSetup { const v=mapping(raw,source,"setup"), kind=oneOf(v.kind,["jj-repository","git-repository"] as const,source,"setup.kind"); if(kind==="jj-repository"){exact(v,["kind","dirty","completedPlanner"],source,"setup");return{kind,dirty:bool(v.dirty,source,"setup.dirty"),...(optionalBool(v,"completedPlanner",source,"setup")===undefined?{}:{completedPlanner:v.completedPlanner as boolean})};} exact(v,["kind","dirty","dirtyManagedWorktree"],source,"setup");return{kind,dirty:bool(v.dirty,source,"setup.dirty"),...(optionalBool(v,"dirtyManagedWorktree",source,"setup")===undefined?{}:{dirtyManagedWorktree:v.dirtyManagedWorktree as boolean})}; }
function workspaceInteraction(raw: unknown,source:string):WorkspaceInteraction{const v=mapping(raw,source,"interaction"),kind=oneOf(v.kind,["create-workspace","integrate-planner","remove-workspace"] as const,source,"interaction.kind");if(kind==="create-workspace"){exact(v,["kind","prompt","includeCurrent"],source,"interaction");return{kind,prompt:str(v.prompt,source,"interaction.prompt"),...(optionalBool(v,"includeCurrent",source,"interaction")===undefined?{}:{includeCurrent:v.includeCurrent as boolean})};}exact(v,["kind","prompt"],source,"interaction");return{kind,prompt:str(v.prompt,source,"interaction.prompt")};}
function workspaceAssertion(raw:unknown,source:string,index:number):WorkspaceAssertion{const path=`assertions[${index}]`,v=mapping(raw,source,path),kind=oneOf(v.kind,["trace-required","trace-prohibited","workspace-created","dirty-source-excluded","dirty-worktree-recoverable","absolute-path-reported"] as const,source,`${path}.kind`);if(kind==="trace-required"||kind==="trace-prohibited"){exact(v,["kind","pattern"],source,path);return{kind,pattern:str(v.pattern,source,`${path}.pattern`)};}if(kind==="workspace-created"){exact(v,["kind","backend"],source,path);return{kind,backend:oneOf(v.backend,["jj","git"] as const,source,`${path}.backend`)};}exact(v,["kind"],source,path);return{kind};}
function subagentSetup(raw: unknown, source: string): SubagentSetup {
  const value = mapping(raw, source, "setup");
  exact(value, ["kind", "parentRole", "childRole", "childOutcome"], source, "setup");
  if (value.kind !== "subagent-harness") fail(source, "setup.kind", "expected subagent-harness");
  const parentRole = oneOf(value.parentRole, ["root", "planner"] as const, source, "setup.parentRole");
  const childRole = oneOf(value.childRole, ["planner", "worker"] as const, source, "setup.childRole");
  if ((parentRole === "root" && childRole !== "planner") || (parentRole === "planner" && childRole !== "worker")) {
    fail(source, "setup.childRole", `${parentRole} cannot directly launch ${childRole} in the packaged hierarchy`);
  }
  return {
    kind: "subagent-harness",
    parentRole,
    childRole,
    childOutcome: oneOf(value.childOutcome, ["running", "completed", "failed", "cancelled"] as const, source, "setup.childOutcome"),
  };
}
function subagentInteraction(raw:unknown,source:string):SubagentInteraction{const v=mapping(raw,source,"interaction"),kind=oneOf(v.kind,["launch-without-collection","wait-any-collection","question-response-resume","rpc-delivery","interim-status-resume","terminal-report","parent-completion","recursive-planner-workspace","inspect-child-record"] as const,source,"interaction.kind");const p="interaction";switch(kind){case"launch-without-collection":case"wait-any-collection":exact(v,["kind","childCount"],source,p);return{kind,childCount:integer(v.childCount,source,`${p}.childCount`)};case"question-response-resume":exact(v,["kind","question","response"],source,p);return{kind,question:str(v.question,source,`${p}.question`),response:str(v.response,source,`${p}.response`)};case"rpc-delivery":exact(v,["kind","delivery","message"],source,p);return{kind,delivery:oneOf(v.delivery,["steer","followUp"] as const,source,`${p}.delivery`),message:str(v.message,source,`${p}.message`)};case"interim-status-resume":exact(v,["kind","role","parentMessage"],source,p);return{kind,role:oneOf(v.role,["planner","worker"] as const,source,`${p}.role`),parentMessage:str(v.parentMessage,source,`${p}.parentMessage`)};case"terminal-report":exact(v,["kind","attemptedReports"],source,p);return{kind,attemptedReports:integer(v.attemptedReports,source,`${p}.attemptedReports`)};case"parent-completion":exact(v,["kind","unresolvedDescendants"],source,p);return{kind,unresolvedDescendants:integer(v.unresolvedDescendants,source,`${p}.unresolvedDescendants`)};case"recursive-planner-workspace":exact(v,["kind","requesterRole"],source,p);return{kind,requesterRole:oneOf(v.requesterRole,["planner","worker"] as const,source,`${p}.requesterRole`)};case"inspect-child-record":exact(v,["kind","outcome"],source,p);return{kind,outcome:oneOf(v.outcome,["failed","cancelled"] as const,source,`${p}.outcome`)};}}
function subagentAssertion(raw:unknown,source:string,index:number):SubagentAssertion{const path=`assertions[${index}]`,v=mapping(raw,source,path),kind=oneOf(v.kind,["protocol-invariant","transcript-sequence","report-count"] as const,source,`${path}.kind`);if(kind==="protocol-invariant"){exact(v,["kind","invariant"],source,path);return{kind,invariant:oneOf(v.invariant,["launch-not-completion","collect-every-child","question-resumes-child","delivery-semantics","single-terminal-report","block-unresolved-parent","deny-recursive-planner-workspace","terminal-record-inspectable"] as const,source,`${path}.invariant`)};}if(kind==="report-count"){exact(v,["kind","phase","count"],source,path);return{kind,phase:oneOf(v.phase,["interim","terminal"] as const,source,`${path}.phase`),count:integer(v.count,source,`${path}.count`)};}exact(v,["kind","events"],source,path);if(!Array.isArray(v.events)||v.events.length===0)fail(source,`${path}.events`,"expected non-empty sequence");return{kind,events:v.events.map((e,i)=>oneOf(e,["parent-steer","visible-bounded-status","subsequent-work","tool-activity","terminal-report"] as const,source,`${path}.events[${i}]`))};}

export function validateCase(raw:unknown,source="<input>"):EvalCase{const v=mapping(raw,source,"$");exact(v,["version","suite","id","title","execution","setup","interaction","assertions"],source,"$");if(v.version!==1)fail(source,"version","expected 1");const id=str(v.id,source,"id");if(!/^[a-z0-9-]+$/.test(id))fail(source,"id","expected lowercase kebab-case");const title=str(v.title,source,"title");const suite=oneOf(v.suite,["workspace-skill","subagents"] as const,source,"suite");if(!Array.isArray(v.assertions)||v.assertions.length===0)fail(source,"assertions","expected non-empty sequence");if(suite==="workspace-skill")return{version:1,suite,id,title,execution:oneOf(v.execution,["executable","specification-only"] as const,source,"execution"),setup:workspaceSetup(v.setup,source),interaction:workspaceInteraction(v.interaction,source),assertions:v.assertions.map((a,i)=>workspaceAssertion(a,source,i))};if(v.execution!=="specification-only")fail(source,"execution","subagent cases must be specification-only");return{version:1,suite,id,title,execution:"specification-only",setup:subagentSetup(v.setup,source),interaction:subagentInteraction(v.interaction,source),assertions:v.assertions.map((a,i)=>subagentAssertion(a,source,i))};}
export async function loadCases(directory:string,expectedSuite?:EvalCase["suite"]):Promise<EvalCase[]>{const files=(await readdir(directory)).filter(f=>f.endsWith(".yaml")||f.endsWith(".yml")).sort(),loaded:EvalCase[]=[];for(const file of files){const source=join(directory,file);let raw:unknown;try{raw=parse(await readFile(source,"utf8"));}catch(error){throw new Error(`${source}: YAML parse failed: ${error instanceof Error?error.message:String(error)}`);}const value=validateCase(raw,source);if(expectedSuite&&value.suite!==expectedSuite)fail(source,"suite",`expected ${expectedSuite}`);loaded.push(value);}const ids=new Set<string>();for(const value of loaded){if(ids.has(value.id))fail(directory,"id",`duplicate case id: ${value.id}`);ids.add(value.id);}return loaded;}
