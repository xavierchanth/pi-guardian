export const SUBAGENT_ROLES = ["standalone", "parent", "child"] as const;
export type SubagentRole = (typeof SUBAGENT_ROLES)[number];

export const MODEL_PREFERENCE_IDS = ["thinker", "worker", "mechanical"] as const;
export type ModelPreferenceId = (typeof MODEL_PREFERENCE_IDS)[number];
export type ThinkingEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelPreference {
  id: ModelPreferenceId | string;
  description: string;
  provider: string;
  model: string;
  effort: ThinkingEffort;
}

export const DEFAULT_MODEL_PREFERENCES: readonly ModelPreference[] = Object.freeze([
  Object.freeze({
    id: "thinker",
    description: "Work requiring investigation, planning, architecture, or substantial judgment.",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    effort: "high",
  }),
  Object.freeze({
    id: "worker",
    description: "Clearly planned work that still requires trusted engineering judgment.",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    effort: "low",
  }),
  Object.freeze({
    id: "mechanical",
    description: "Explicit repetitive transformations requiring minimal discretionary judgment.",
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    effort: "high",
  }),
]);

export const PARENT_TOOL_NAMES = [
  "spawn_child",
  "message_child",
  "wait_for_children",
  "child_status",
  "integrate_child",
  "abandon_child",
] as const;
export const CHILD_TOOL_NAMES = ["report_to_parent"] as const;
export const ROLE_TOOL_NAMES = [...PARENT_TOOL_NAMES, ...CHILD_TOOL_NAMES] as const;

export type SubagentsCommand = "on" | "off" | "status";

export function parseSubagentsCommand(input: string): SubagentsCommand | undefined {
  const value = input.trim().toLowerCase();
  if (!value || value === "on") return "on";
  if (value === "off" || value === "status") return value;
  return undefined;
}

export function activeToolsForRole(
  activeTools: readonly string[],
  role: SubagentRole,
): string[] {
  const roleTools = new Set<string>(ROLE_TOOL_NAMES);
  const result = activeTools.filter((name) => !roleTools.has(name));
  if (role === "parent") result.push(...PARENT_TOOL_NAMES);
  if (role === "child") result.push(...CHILD_TOOL_NAMES);
  return [...new Set(result)];
}

export interface ComposeInstructionOptions {
  basePrompt: string;
  role: SubagentRole;
  systemInstructions: string;
  roleInstructions: string;
  modelPreferences?: readonly ModelPreference[];
  delegation?: {
    id: string;
    parentSessionId: string;
    workspace: string;
    baseChangeId: string;
    childRootChangeId: string;
  };
}

export function composePiTaiInstructions(options: ComposeInstructionOptions): string {
  const sections: string[] = [options.basePrompt];
  const system = options.systemInstructions.trim();
  if (system) sections.push(`<pi_tai_instructions>\n${system}\n</pi_tai_instructions>`);

  const roleInstructions = options.roleInstructions.trim();
  if (roleInstructions) {
    sections.push(`<pi_tai_role_instructions role="${options.role}">\n${roleInstructions}\n</pi_tai_role_instructions>`);
  }

  if (options.role !== "standalone") {
    const facts = [`<pi_tai_subagents subagent_role="${options.role}">`];
    if (options.role === "parent") {
      facts.push(
        '<delegation_policy jj_workspace_creation="spawn_child_only" parent_work_while_child_active="forbidden" next_action_after_spawn="wait_for_children" />',
      );
      for (const preference of options.modelPreferences ?? []) {
        facts.push(
          `<model_preference id="${escapeAttribute(preference.id)}" provider="${escapeAttribute(preference.provider)}" model="${escapeAttribute(preference.model)}" effort="${preference.effort}">${escapeText(preference.description)}</model_preference>`,
        );
      }
    }
    if (options.delegation) {
      facts.push(
        `<delegation id="${escapeAttribute(options.delegation.id)}" parent_session_id="${escapeAttribute(options.delegation.parentSessionId)}" workspace="${escapeAttribute(options.delegation.workspace)}" base_change_id="${escapeAttribute(options.delegation.baseChangeId)}" child_root_change_id="${escapeAttribute(options.delegation.childRootChangeId)}" />`,
      );
    }
    facts.push("</pi_tai_subagents>");
    sections.push(facts.join("\n"));
  }

  return sections.join("\n\n");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;");
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
