import type { UncertaintyHandling } from "./agents.ts";

export const TASK_RESOURCE_TYPES = ["file", "directory", "url", "commit"] as const;
export type TaskResourceType = (typeof TASK_RESOURCE_TYPES)[number];

export interface TaskResource {
  type: TaskResourceType;
  value: string;
  reason?: string;
}

export interface TaskPacket {
  objective: string;
  context?: string[];
  resources?: TaskResource[];
  constraints?: string[];
  acceptanceCriteria?: string[];
  expectedOutput?: string;
  uncertaintyHandling?: UncertaintyHandling;
}

export interface ResolvedTaskPacket extends Omit<TaskPacket, "uncertaintyHandling"> {
  uncertaintyHandling: UncertaintyHandling;
}

export function normalizeTaskPacket(
  input: TaskPacket,
  fallback: UncertaintyHandling,
): ResolvedTaskPacket {
  const objective = boundedText(input.objective, "objective", 16_000);
  return {
    objective,
    ...normalizeList(input.context, "context"),
    ...normalizeResources(input.resources),
    ...normalizeList(input.constraints, "constraints"),
    ...normalizeList(input.acceptanceCriteria, "acceptance criteria"),
    ...(input.expectedOutput === undefined
      ? {}
      : { expectedOutput: boundedText(input.expectedOutput, "expected output", 8_000) }),
    uncertaintyHandling: input.uncertaintyHandling ?? fallback,
  };
}

export function renderTaskPacket(task: ResolvedTaskPacket): string {
  const sections = [section("OBJECTIVE", [task.objective])];
  if (task.context?.length) sections.push(section("CONTEXT", task.context));
  if (task.resources?.length) {
    sections.push(section("RESOURCES", task.resources.map((resource) =>
      `[${resource.type}] ${resource.value}${resource.reason ? ` — ${resource.reason}` : ""}`,
    )));
  }
  if (task.constraints?.length) sections.push(section("CONSTRAINTS", task.constraints));
  if (task.acceptanceCriteria?.length) {
    sections.push(section("ACCEPTANCE CRITERIA", task.acceptanceCriteria));
  }
  if (task.expectedOutput) sections.push(section("EXPECTED OUTPUT", [task.expectedOutput]));
  sections.push(section("UNCERTAINTY HANDLING", [uncertaintyInstruction(task.uncertaintyHandling)]));
  return sections.join("\n\n");
}

function normalizeList(
  values: string[] | undefined,
  label: string,
): Record<string, string[]> {
  if (values === undefined) return {};
  if (!Array.isArray(values) || values.length > 64) {
    throw new Error(`Task ${label} must contain at most 64 items.`);
  }
  const normalized = values.map((value, index) => boundedText(value, `${label} item ${index + 1}`, 4_000));
  const key = label === "acceptance criteria" ? "acceptanceCriteria" : label;
  return { [key]: normalized };
}

function normalizeResources(resources: TaskResource[] | undefined): { resources?: TaskResource[] } {
  if (resources === undefined) return {};
  if (!Array.isArray(resources) || resources.length > 64) {
    throw new Error("Task resources must contain at most 64 items.");
  }
  return {
    resources: resources.map((resource, index) => {
      if (!TASK_RESOURCE_TYPES.includes(resource.type)) {
        throw new Error(`Invalid task resource type at item ${index + 1}.`);
      }
      return {
        type: resource.type,
        value: boundedText(resource.value, `resource ${index + 1}`, 8_000),
        ...(resource.reason === undefined
          ? {}
          : { reason: boundedText(resource.reason, `resource reason ${index + 1}`, 2_000) }),
      };
    }),
  };
}

function boundedText(value: string, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Task ${label} must not be empty.`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new Error(`Task ${label} exceeds ${maximum} characters.`);
  return normalized;
}

function section(title: string, values: readonly string[]): string {
  return `${title}\n${values.map((value) => `- ${value}`).join("\n")}`;
}

function uncertaintyInstruction(handling: UncertaintyHandling): string {
  switch (handling) {
    case "best-effort":
      return "Make the safest reasonable assumption, continue, and disclose the assumption in your report.";
    case "block":
      return "Do not guess through material ambiguity. Report a blocked outcome with options and a recommendation.";
    case "ask-parent":
      return "For material ambiguity, call ask_parent and wait for a correlated response before continuing.";
  }
}
