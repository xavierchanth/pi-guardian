import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

export type ConcurrencyEvalCase = {
  version: 1;
  suite: "agent-concurrency";
  id: string;
  title: string;
  mode: "policy" | "real-jj";
  prompt: string;
  expectedTools: string[];
  forbiddenTools: string[];
  expectedReportFields: string[];
};

export async function loadConcurrencyCases(directory: string): Promise<ConcurrencyEvalCase[]> {
  const files = (await readdir(directory)).filter((file) => /\.ya?ml$/.test(file)).sort();
  const cases: ConcurrencyEvalCase[] = [];
  for (const file of files) {
    const source = join(directory, file);
    let raw: unknown;
    try {
      raw = parse(await readFile(source, "utf8"));
    } catch (error) {
      throw new Error(`${source}: YAML parse failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    cases.push(validateConcurrencyCase(raw, source));
  }
  const ids = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`${directory}: duplicate case ID: ${item.id}`);
    ids.add(item.id);
  }
  if (!cases.some((item) => item.mode === "policy")) throw new Error(`${directory}: at least one policy case is required.`);
  if (!cases.some((item) => item.mode === "real-jj")) throw new Error(`${directory}: at least one Real-JJ case is required.`);
  return cases;
}

export function validateConcurrencyCase(raw: unknown, source = "<input>"): ConcurrencyEvalCase {
  const value = record(raw, source, "$");
  exact(value, ["version", "suite", "id", "title", "mode", "prompt", "expectedTools", "forbiddenTools", "expectedReportFields"], source);
  if (value.version !== 1) fail(source, "version", "expected 1");
  if (value.suite !== "agent-concurrency") fail(source, "suite", "expected agent-concurrency");
  const id = text(value.id, source, "id");
  if (!/^[a-z0-9-]+$/.test(id)) fail(source, "id", "expected lowercase kebab-case");
  const mode = oneOf(value.mode, ["policy", "real-jj"] as const, source, "mode");
  const expectedTools = textList(value.expectedTools, source, "expectedTools");
  const forbiddenTools = textList(value.forbiddenTools, source, "forbiddenTools");
  const overlap = expectedTools.filter((tool) => forbiddenTools.includes(tool));
  if (overlap.length) fail(source, "expectedTools", `also forbidden: ${overlap.join(", ")}`);
  return {
    version: 1,
    suite: "agent-concurrency",
    id,
    title: text(value.title, source, "title"),
    mode,
    prompt: text(value.prompt, source, "prompt"),
    expectedTools,
    forbiddenTools,
    expectedReportFields: textList(value.expectedReportFields, source, "expectedReportFields"),
  };
}

function record(value: unknown, source: string, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(source, path, "expected mapping");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[], source: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(source, key, "unknown field");
}
function text(value: unknown, source: string, path: string): string {
  if (typeof value !== "string" || !value.trim()) fail(source, path, "expected nonempty string");
  return value.trim();
}
function textList(value: unknown, source: string, path: string): string[] {
  if (!Array.isArray(value)) fail(source, path, "expected list");
  return value.map((item, index) => text(item, source, `${path}[${index}]`));
}
function oneOf<T extends string>(value: unknown, choices: readonly T[], source: string, path: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) fail(source, path, `expected one of: ${choices.join(", ")}`);
  return value as T;
}
function fail(source: string, path: string, reason: string): never { throw new Error(`${source}:${path}: ${reason}`); }
