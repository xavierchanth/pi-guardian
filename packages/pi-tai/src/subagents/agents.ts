import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  parseFrontmatter,
} from "@earendil-works/pi-coding-agent";

export const AGENT_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];
export const UNCERTAINTY_HANDLINGS = ["best-effort", "block", "ask-parent"] as const;
export type UncertaintyHandling = (typeof UNCERTAINTY_HANDLINGS)[number];
export type AgentDefinitionSource = "packaged" | "user" | "project";

export interface AgentDefinition {
  name: string;
  description: string;
  root: boolean;
  provider: string;
  model: string;
  effort: AgentEffort;
  tools: readonly string[];
  allowedChildren: readonly string[];
  uncertaintyHandling: UncertaintyHandling;
  systemPrompt: string;
  source: AgentDefinitionSource;
  filePath: string;
  contentHash: string;
}

export interface AgentCatalog {
  root: AgentDefinition;
  agents: readonly AgentDefinition[];
  byName: ReadonlyMap<string, AgentDefinition>;
  projectAgentsDir?: string;
}

export interface DiscoverAgentDefinitionsOptions {
  cwd: string;
  projectTrusted: boolean;
  agentDir?: string;
  packagedDir?: string;
}

const FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "root",
  "model",
  "effort",
  "tools",
  "allowed-children",
  "uncertainty-handling",
]);
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const TOOL_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/;

export function discoverAgentDefinitions(options: DiscoverAgentDefinitionsOptions): AgentCatalog {
  const packagedDir = options.packagedDir
    ?? fileURLToPath(new URL("../../agents", import.meta.url));
  const agentDir = options.agentDir ?? getAgentDir();
  const projectAgentsDir = findNearestProjectAgentsDir(options.cwd);
  const effective = new Map<string, AgentDefinition>();

  for (const definition of loadDefinitions(packagedDir, "packaged")) {
    effective.set(definition.name, definition);
  }
  for (const definition of loadDefinitions(join(agentDir, "agents"), "user")) {
    effective.set(definition.name, definition);
  }
  if (options.projectTrusted && projectAgentsDir) {
    for (const definition of loadDefinitions(projectAgentsDir, "project")) {
      effective.set(definition.name, definition);
    }
  }

  const agents = [...effective.values()].sort((left, right) => left.name.localeCompare(right.name));
  if (agents.length === 0) throw new Error("No Pi-Tai agent definitions were found.");
  const roots = agents.filter((definition) => definition.root);
  if (roots.length !== 1) {
    throw new Error(`Agent catalog must contain exactly one root definition; found ${roots.length}.`);
  }
  validateGraph(effective);
  return {
    root: roots[0],
    agents,
    byName: effective,
    ...(options.projectTrusted && projectAgentsDir ? { projectAgentsDir } : {}),
  };
}

export function validateAgentTools(
  definition: AgentDefinition,
  availableTools: ReadonlySet<string>,
): void {
  const unavailable = definition.tools.filter((tool) => !availableTools.has(tool));
  if (unavailable.length > 0) {
    throw new Error(
      `Agent "${definition.name}" requires unavailable tools: ${unavailable.join(", ")} (${definition.filePath}).`,
    );
  }
}

function loadDefinitions(directory: string, source: AgentDefinitionSource): AgentDefinition[] {
  if (!isDirectory(directory)) return [];
  const definitions: AgentDefinition[] = [];
  const names = new Set<string>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    const unresolvedPath = join(directory, entry.name);
    const filePath = realpathSync(unresolvedPath);
    const content = readFileSync(filePath, "utf8");
    const definition = parseDefinition(content, source, filePath);
    if (names.has(definition.name)) {
      throw new Error(`Duplicate agent "${definition.name}" in ${directory}.`);
    }
    names.add(definition.name);
    definitions.push(definition);
  }
  return definitions;
}

function parseDefinition(
  content: string,
  source: AgentDefinitionSource,
  filePath: string,
): AgentDefinition {
  const parsed = parseFrontmatter<Record<string, unknown>>(content);
  const frontmatter = parsed.frontmatter;
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new Error(`Invalid agent front matter in ${filePath}.`);
  }
  for (const key of Object.keys(frontmatter)) {
    if (!FRONTMATTER_KEYS.has(key)) throw new Error(`Unknown agent field "${key}" in ${filePath}.`);
  }
  const name = requiredString(frontmatter.name, "name", filePath);
  if (!NAME_PATTERN.test(name)) throw new Error(`Invalid agent name "${name}" in ${filePath}.`);
  const description = requiredString(frontmatter.description, "description", filePath);
  const modelId = requiredString(frontmatter.model, "model", filePath);
  const separator = modelId.indexOf("/");
  if (separator <= 0 || separator === modelId.length - 1) {
    throw new Error(`Agent model must be provider/model in ${filePath}.`);
  }
  const effort = requiredString(frontmatter.effort, "effort", filePath);
  if (!AGENT_EFFORTS.includes(effort as AgentEffort)) {
    throw new Error(`Invalid agent effort "${effort}" in ${filePath}.`);
  }
  const tools = stringArray(frontmatter.tools, "tools", filePath, false);
  for (const tool of tools) {
    if (!TOOL_PATTERN.test(tool)) throw new Error(`Invalid tool name "${tool}" in ${filePath}.`);
  }
  const allowedChildren = stringArray(
    frontmatter["allowed-children"],
    "allowed-children",
    filePath,
    true,
  );
  for (const child of allowedChildren) {
    if (!NAME_PATTERN.test(child)) throw new Error(`Invalid child agent name "${child}" in ${filePath}.`);
  }
  const hasSubagent = tools.includes("subagent");
  if (hasSubagent !== (allowedChildren.length > 0)) {
    throw new Error(
      `Agent "${name}" must declare both the subagent tool and at least one allowed child, or neither (${filePath}).`,
    );
  }
  const uncertainty = frontmatter["uncertainty-handling"] === undefined
    ? "block"
    : requiredString(frontmatter["uncertainty-handling"], "uncertainty-handling", filePath);
  if (!UNCERTAINTY_HANDLINGS.includes(uncertainty as UncertaintyHandling)) {
    throw new Error(`Invalid uncertainty handling "${uncertainty}" in ${filePath}.`);
  }
  const systemPrompt = parsed.body.trim();
  if (!systemPrompt) throw new Error(`Agent system prompt must not be empty in ${filePath}.`);
  if (frontmatter.root !== undefined && typeof frontmatter.root !== "boolean") {
    throw new Error(`Agent root must be a boolean in ${filePath}.`);
  }
  return Object.freeze({
    name,
    description,
    root: frontmatter.root === true,
    provider: modelId.slice(0, separator),
    model: modelId.slice(separator + 1),
    effort: effort as AgentEffort,
    tools: Object.freeze(tools),
    allowedChildren: Object.freeze(allowedChildren),
    uncertaintyHandling: uncertainty as UncertaintyHandling,
    systemPrompt,
    source,
    filePath,
    contentHash: createHash("sha256").update(content).digest("hex"),
  });
}

function validateGraph(definitions: ReadonlyMap<string, AgentDefinition>): void {
  for (const definition of definitions.values()) {
    for (const childName of definition.allowedChildren) {
      if (!definitions.has(childName)) {
        throw new Error(
          `Agent "${definition.name}" references unknown child "${childName}" (${definition.filePath}).`,
        );
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string, path: readonly string[]) => {
    if (visiting.has(name)) throw new Error(`Agent child graph contains a cycle: ${[...path, name].join(" -> ")}.`);
    if (visited.has(name)) return;
    visiting.add(name);
    const definition = definitions.get(name)!;
    for (const child of definition.allowedChildren) visit(child, [...path, name]);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of definitions.keys()) visit(name, []);
}

function stringArray(
  value: unknown,
  field: string,
  filePath: string,
  optional: boolean,
): string[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`Agent ${field} must be an array of non-empty strings in ${filePath}.`);
  }
  const values = value.map((entry) => (entry as string).trim());
  if (new Set(values).size !== values.length) throw new Error(`Agent ${field} contains duplicates in ${filePath}.`);
  return values;
}

function requiredString(value: unknown, field: string, filePath: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Agent ${field} must be a non-empty string in ${filePath}.`);
  }
  return value.trim();
}

function findNearestProjectAgentsDir(cwd: string): string | undefined {
  let current = cwd;
  while (true) {
    const candidate = join(current, CONFIG_DIR_NAME, "agents");
    if (isDirectory(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function isDirectory(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
