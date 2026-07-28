import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

export type SubagentParentRole = "root" | "implementation-lead";
export type ChildOutcome = "running" | "completed" | "failed" | "cancelled";
export type SubagentSetup = { kind: "subagent-harness"; parentRole: SubagentParentRole; childRole: "implementation-lead" | "worker"; childOutcome: ChildOutcome };
export type SubagentInteraction =
  | { kind: "launch-without-collection"; childCount: number }
  | { kind: "wait-any-collection"; childCount: number }
  | { kind: "question-response-resume"; question: string; response: string }
  | { kind: "rpc-delivery"; delivery: "steer" | "followUp"; message: string }
  | { kind: "interim-status-resume"; role: "implementation-lead" | "worker"; parentMessage: string }
  | { kind: "terminal-report"; attemptedReports: number }
  | { kind: "parent-completion"; unresolvedDescendants: number }
  | { kind: "recursive-implementation-lead-workspace"; requesterRole: "implementation-lead" | "worker" }
  | { kind: "inspect-child-record"; outcome: "failed" | "cancelled" };
export type TranscriptEvent = "parent-steer" | "visible-bounded-status" | "subsequent-work" | "tool-activity" | "terminal-report";
export type SubagentAssertion =
  | { kind: "protocol-invariant"; invariant: "launch-not-completion" | "collect-every-child" | "question-resumes-child" | "delivery-semantics" | "single-terminal-report" | "block-unresolved-parent" | "deny-recursive-implementation-lead-workspace" | "terminal-record-inspectable" }
  | { kind: "transcript-sequence"; events: TranscriptEvent[] }
  | { kind: "report-count"; phase: "interim" | "terminal"; count: number };
export type SubagentCase = { version: 1; suite: "subagents"; id: string; title: string; execution: "specification-only"; setup: SubagentSetup; interaction: SubagentInteraction; assertions: SubagentAssertion[] };

function fail(source: string, path: string, message: string): never { throw new Error(`${source}:${path}: ${message}`); }
function mapping(value: unknown, source: string, path: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail(source, path, "expected mapping"); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, allowed: readonly string[], source: string, path: string): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(source, `${path}.${key}`, "unknown field"); }
function str(value: unknown, source: string, path: string): string { if (typeof value !== "string" || value.length === 0) fail(source, path, "expected non-empty string"); return value; }
function integer(value: unknown, source: string, path: string): number { if (!Number.isInteger(value) || (value as number) < 0) fail(source, path, "expected non-negative integer"); return value as number; }
function oneOf<T extends string>(value: unknown, choices: readonly T[], source: string, path: string): T { if (typeof value !== "string" || !choices.includes(value as T)) fail(source, path, `expected one of: ${choices.join(", ")}`); return value as T; }

function subagentSetup(raw: unknown, source: string): SubagentSetup {
  const value = mapping(raw, source, "setup");
  exact(value, ["kind", "parentRole", "childRole", "childOutcome"], source, "setup");
  if (value.kind !== "subagent-harness") fail(source, "setup.kind", "expected subagent-harness");
  const parentRole = oneOf(value.parentRole, ["root", "implementation-lead"] as const, source, "setup.parentRole");
  const childRole = oneOf(value.childRole, ["implementation-lead", "worker"] as const, source, "setup.childRole");
  if ((parentRole === "root" && childRole !== "implementation-lead") || (parentRole === "implementation-lead" && childRole !== "worker")) {
    fail(source, "setup.childRole", `${parentRole} cannot directly launch ${childRole} in the packaged hierarchy`);
  }
  return {
    kind: "subagent-harness",
    parentRole,
    childRole,
    childOutcome: oneOf(value.childOutcome, ["running", "completed", "failed", "cancelled"] as const, source, "setup.childOutcome"),
  };
}

function subagentInteraction(raw: unknown, source: string): SubagentInteraction {
  const value = mapping(raw, source, "interaction");
  const kind = oneOf(value.kind, ["launch-without-collection", "wait-any-collection", "question-response-resume", "rpc-delivery", "interim-status-resume", "terminal-report", "parent-completion", "recursive-implementation-lead-workspace", "inspect-child-record"] as const, source, "interaction.kind");
  const path = "interaction";
  switch (kind) {
    case "launch-without-collection":
    case "wait-any-collection":
      exact(value, ["kind", "childCount"], source, path);
      return { kind, childCount: integer(value.childCount, source, `${path}.childCount`) };
    case "question-response-resume":
      exact(value, ["kind", "question", "response"], source, path);
      return { kind, question: str(value.question, source, `${path}.question`), response: str(value.response, source, `${path}.response`) };
    case "rpc-delivery":
      exact(value, ["kind", "delivery", "message"], source, path);
      return { kind, delivery: oneOf(value.delivery, ["steer", "followUp"] as const, source, `${path}.delivery`), message: str(value.message, source, `${path}.message`) };
    case "interim-status-resume":
      exact(value, ["kind", "role", "parentMessage"], source, path);
      return { kind, role: oneOf(value.role, ["implementation-lead", "worker"] as const, source, `${path}.role`), parentMessage: str(value.parentMessage, source, `${path}.parentMessage`) };
    case "terminal-report":
      exact(value, ["kind", "attemptedReports"], source, path);
      return { kind, attemptedReports: integer(value.attemptedReports, source, `${path}.attemptedReports`) };
    case "parent-completion":
      exact(value, ["kind", "unresolvedDescendants"], source, path);
      return { kind, unresolvedDescendants: integer(value.unresolvedDescendants, source, `${path}.unresolvedDescendants`) };
    case "recursive-implementation-lead-workspace":
      exact(value, ["kind", "requesterRole"], source, path);
      return { kind, requesterRole: oneOf(value.requesterRole, ["implementation-lead", "worker"] as const, source, `${path}.requesterRole`) };
    case "inspect-child-record":
      exact(value, ["kind", "outcome"], source, path);
      return { kind, outcome: oneOf(value.outcome, ["failed", "cancelled"] as const, source, `${path}.outcome`) };
  }
}

function subagentAssertion(raw: unknown, source: string, index: number): SubagentAssertion {
  const path = `assertions[${index}]`;
  const value = mapping(raw, source, path);
  const kind = oneOf(value.kind, ["protocol-invariant", "transcript-sequence", "report-count"] as const, source, `${path}.kind`);
  if (kind === "protocol-invariant") {
    exact(value, ["kind", "invariant"], source, path);
    return { kind, invariant: oneOf(value.invariant, ["launch-not-completion", "collect-every-child", "question-resumes-child", "delivery-semantics", "single-terminal-report", "block-unresolved-parent", "deny-recursive-implementation-lead-workspace", "terminal-record-inspectable"] as const, source, `${path}.invariant`) };
  }
  if (kind === "report-count") {
    exact(value, ["kind", "phase", "count"], source, path);
    return { kind, phase: oneOf(value.phase, ["interim", "terminal"] as const, source, `${path}.phase`), count: integer(value.count, source, `${path}.count`) };
  }
  exact(value, ["kind", "events"], source, path);
  if (!Array.isArray(value.events) || value.events.length === 0) fail(source, `${path}.events`, "expected non-empty sequence");
  return { kind, events: value.events.map((event, eventIndex) => oneOf(event, ["parent-steer", "visible-bounded-status", "subsequent-work", "tool-activity", "terminal-report"] as const, source, `${path}.events[${eventIndex}]`)) };
}

export function validateCase(raw: unknown, source = "<input>"): SubagentCase {
  const value = mapping(raw, source, "$");
  exact(value, ["version", "suite", "id", "title", "execution", "setup", "interaction", "assertions"], source, "$");
  if (value.version !== 1) fail(source, "version", "expected 1");
  if (value.suite !== "subagents") fail(source, "suite", "expected subagents");
  if (value.execution !== "specification-only") fail(source, "execution", "subagent cases must be specification-only");
  const id = str(value.id, source, "id");
  if (!/^[a-z0-9-]+$/.test(id)) fail(source, "id", "expected lowercase kebab-case");
  if (!Array.isArray(value.assertions) || value.assertions.length === 0) fail(source, "assertions", "expected non-empty sequence");
  return {
    version: 1,
    suite: "subagents",
    id,
    title: str(value.title, source, "title"),
    execution: "specification-only",
    setup: subagentSetup(value.setup, source),
    interaction: subagentInteraction(value.interaction, source),
    assertions: value.assertions.map((assertion, index) => subagentAssertion(assertion, source, index)),
  };
}

export async function loadCases(directory: string, expectedSuite: "subagents" = "subagents"): Promise<SubagentCase[]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".yaml") || file.endsWith(".yml")).sort();
  const loaded: SubagentCase[] = [];
  for (const file of files) {
    const source = join(directory, file);
    let raw: unknown;
    try { raw = parse(await readFile(source, "utf8")); }
    catch (error) { throw new Error(`${source}: YAML parse failed: ${error instanceof Error ? error.message : String(error)}`); }
    const value = validateCase(raw, source);
    if (value.suite !== expectedSuite) fail(source, "suite", `expected ${expectedSuite}`);
    loaded.push(value);
  }
  const ids = new Set<string>();
  for (const value of loaded) {
    if (ids.has(value.id)) fail(directory, "id", `duplicate case id: ${value.id}`);
    ids.add(value.id);
  }
  return loaded;
}
