import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  MODEL_PROFILES,
  MODEL_PROFILE_IDS,
  type ModelProfile,
  type ModelProfileId,
  type ThinkingEffort,
} from "../model-profiles/domain.ts";

export const SUBAGENT_ROLES = ["standalone", "parent", "child"] as const;
export type SubagentRole = (typeof SUBAGENT_ROLES)[number];

// Backward-compatible subagent names backed by the shared profile definitions.
export const MODEL_PREFERENCE_IDS = MODEL_PROFILE_IDS;
export type ModelPreferenceId = ModelProfileId;
export type ModelPreference = ModelProfile;
export type { ThinkingEffort };
export const DEFAULT_MODEL_PREFERENCES = MODEL_PROFILES;

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

export function reconstructSubagentRole(entries: readonly SessionEntry[]): {
  role: SubagentRole;
  delegationId?: string;
} {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== "pi-tai-subagent-role") continue;
    const data = entry.data as { role?: unknown; delegationId?: unknown } | undefined;
    if (data?.role === "standalone" || data?.role === "parent" || data?.role === "child") {
      return {
        role: data.role,
        ...(typeof data.delegationId === "string" ? { delegationId: data.delegationId } : {}),
      };
    }
  }
  return { role: "standalone" };
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
    backend: "jj" | "git";
    workspace: string;
    baseId: string;
    rootId: string;
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
        '<delegation_policy workspace_creation="spawn_child_only" backend_selection="jj_then_git" jj_child_base="parent_@-" child_workspace_owner="child_exclusive" parent_work_while_child_active="forbidden" next_action_after_spawn="wait_for_children" />',
      );
      for (const preference of options.modelPreferences ?? []) {
        facts.push(
          `<model_preference id="${escapeAttribute(preference.id)}" provider="${escapeAttribute(preference.provider)}" model="${escapeAttribute(preference.model)}" effort="${preference.effort}">${escapeText(preference.description)}</model_preference>`,
        );
      }
    }
    if (options.delegation) {
      facts.push(
        `<delegation id="${escapeAttribute(options.delegation.id)}" parent_session_id="${escapeAttribute(options.delegation.parentSessionId)}" backend="${options.delegation.backend}" workspace="${escapeAttribute(options.delegation.workspace)}" base_id="${escapeAttribute(options.delegation.baseId)}" root_id="${escapeAttribute(options.delegation.rootId)}" />`,
      );
      facts.push(
        '<workspace_ownership owner="child_exclusive" repository_reads_edits_tests_and_vcs="delegated_workspace_only" parent_must_not_duplicate_or_modify="true" />',
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
