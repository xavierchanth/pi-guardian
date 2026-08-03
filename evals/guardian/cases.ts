import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export type GuardianReviewFailure = "timeout" | "cancelled" | "provider-failure";
export type GuardianFallbackClassification =
  | "local-read-only"
  | "remote-read-only"
  | "development-command"
  | "repository-edit"
  | "vcs-checkpoint"
  | "destructive-filesystem"
  | "destructive-vcs";
export type GuardianFallbackDisposition = "allow" | "block";

export interface GuardianFallbackCase {
  id: string;
  title: string;
  reviewFailure: GuardianReviewFailure;
  action: {
    toolName: string;
    cwd: string;
    arguments: Record<string, unknown>;
  };
  expected: {
    classification: GuardianFallbackClassification;
    disposition: GuardianFallbackDisposition;
    rationale: string;
  };
}

export interface GuardianFallbackCorpus {
  version: 1;
  suite: "guardian-review-fallback";
  description: string;
  cases: GuardianFallbackCase[];
}

export async function loadGuardianFallbackCorpus(source: string): Promise<GuardianFallbackCorpus> {
  let raw: unknown;
  try {
    raw = parse(await readFile(source, "utf8"));
  } catch (error) {
    throw new Error(
      `${source}: YAML parse failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateGuardianFallbackCorpus(raw, source);
}

export function validateGuardianFallbackCorpus(
  raw: unknown,
  source = "<input>",
): GuardianFallbackCorpus {
  const value = record(raw, source, "$");
  exact(value, ["version", "suite", "description", "cases"], source, "$");
  if (value.version !== 1) fail(source, "version", "expected 1");
  if (value.suite !== "guardian-review-fallback")
    fail(source, "suite", "expected guardian-review-fallback");
  if (!Array.isArray(value.cases) || value.cases.length === 0)
    fail(source, "cases", "expected non-empty sequence");

  const cases = value.cases.map((item, index) => guardianCase(item, source, index));
  const ids = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.id)) fail(source, "cases", `duplicate case ID: ${item.id}`);
    ids.add(item.id);
  }

  const corpus: GuardianFallbackCorpus = {
    version: 1,
    suite: "guardian-review-fallback",
    description: text(value.description, source, "description"),
    cases,
  };
  const serialized = JSON.stringify(corpus);
  if (/\.jj\/workspaces\//.test(serialized))
    fail(source, "cases", "managed workspace paths must be normalized to .jj/workspaces");
  if (/"timestamp"\s*:/.test(serialized) || /20\d{2}-\d{2}-\d{2}T/.test(serialized))
    fail(source, "cases", "timestamps are not permitted");
  if (/\/(?:Users|home|Applications|opt|var|private)\//.test(serialized))
    fail(source, "cases", "machine-specific absolute paths are not permitted");
  if (/[0-9a-f]{16,}/i.test(serialized))
    fail(source, "cases", "opaque source identifiers are not permitted");
  for (const match of serialized.matchAll(/https?:\/\/([^/\\"\s]+)/g)) {
    if (match[1] !== "example.invalid")
      fail(source, "cases", "only reserved synthetic URL hosts are permitted");
  }
  return corpus;
}

function guardianCase(raw: unknown, source: string, index: number): GuardianFallbackCase {
  const path = `cases[${index}]`;
  const value = record(raw, source, path);
  exact(value, ["id", "title", "reviewFailure", "action", "expected"], source, path);
  const id = text(value.id, source, `${path}.id`);
  if (!/^[a-z0-9-]+$/.test(id)) fail(source, `${path}.id`, "expected lowercase kebab-case");

  const actionPath = `${path}.action`;
  const action = record(value.action, source, actionPath);
  exact(action, ["toolName", "cwd", "arguments"], source, actionPath);

  const expectedPath = `${path}.expected`;
  const expected = record(value.expected, source, expectedPath);
  exact(expected, ["classification", "disposition", "rationale"], source, expectedPath);

  return {
    id,
    title: text(value.title, source, `${path}.title`),
    reviewFailure: oneOf(
      value.reviewFailure,
      ["timeout", "cancelled", "provider-failure"] as const,
      source,
      `${path}.reviewFailure`,
    ),
    action: {
      toolName: text(action.toolName, source, `${actionPath}.toolName`),
      cwd: text(action.cwd, source, `${actionPath}.cwd`),
      arguments: record(action.arguments, source, `${actionPath}.arguments`),
    },
    expected: {
      classification: oneOf(
        expected.classification,
        [
          "local-read-only",
          "remote-read-only",
          "development-command",
          "repository-edit",
          "vcs-checkpoint",
          "destructive-filesystem",
          "destructive-vcs",
        ] as const,
        source,
        `${expectedPath}.classification`,
      ),
      disposition: oneOf(
        expected.disposition,
        ["allow", "block"] as const,
        source,
        `${expectedPath}.disposition`,
      ),
      rationale: text(expected.rationale, source, `${expectedPath}.rationale`),
    },
  };
}

function record(value: unknown, source: string, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(source, path, "expected mapping");
  return value as Record<string, unknown>;
}
function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
  source: string,
  path: string,
): void {
  for (const key of Object.keys(value))
    if (!keys.includes(key)) fail(source, `${path}.${key}`, "unknown field");
}
function text(value: unknown, source: string, path: string): string {
  if (typeof value !== "string" || !value.trim()) fail(source, path, "expected non-empty string");
  return value.trim();
}
function oneOf<T extends string>(
  value: unknown,
  choices: readonly T[],
  source: string,
  path: string,
): T {
  if (typeof value !== "string" || !choices.includes(value as T))
    fail(source, path, `expected one of: ${choices.join(", ")}`);
  return value as T;
}
function fail(source: string, path: string, reason: string): never {
  throw new Error(`${source}:${path}: ${reason}`);
}
