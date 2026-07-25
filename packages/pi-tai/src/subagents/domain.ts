import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { UncertaintyHandling } from "./agents.ts";

export const SUBAGENT_MODES = ["standalone", "root", "child"] as const;
export type SubagentMode = (typeof SUBAGENT_MODES)[number];

export const PARENT_TOOL_NAMES = [
  "subagent",
  "message_child",
  "await_child_event",
  "ack_child_event",
  "reconcile_children",
  "request_child_status",
  "concurrency_usage",
  "respond_to_child",
  "abandon_child",
  "workspace_subagent",
  "integrate_workspace",
  "describe_integrated_changes",
  "jj_concurrency_status",
  "ensure_wip_change",
  "insert_change",
  "acquire_file_set",
  "release_file_set",
  "checkpoint_change",
  "workspace_checkpoint",
  "assign_workspace_change",
  "acquire_workspace_file_set",
  "release_workspace_file_set",
  "checkpoint_workspace_file_set",
  "normalize_change_range",
  "prepare_workspace_report",
  "rebase_workspace",
  "task_create",
  "task_assign",
  "task_plan",
  "task_record_user_direction",
  "task_status",
  "prepare_workspace_review",
  "workspace_review_status",
  "submit_workspace_review",
  "accept_workspace_review",
  "begin_workspace_repair",
  "verify_integrated_range",
  "close_workspace",
  "resume_workspace_operation",
  "rebind_tracked_change",
  "retry_workspace_cleanup",
  "workspace_custody_status",
  "workspace_recovery_plan",
  "squash_resolution",
] as const;
const BASE_CHILD_PROTOCOL_TOOL_NAMES = ["message_parent", "report_to_parent", "report_status"] as const;
export const CHILD_PROTOCOL_TOOL_NAMES = [...BASE_CHILD_PROTOCOL_TOOL_NAMES, "ask_parent"] as const;
export const ROLE_TOOL_NAMES = [...PARENT_TOOL_NAMES, ...CHILD_PROTOCOL_TOOL_NAMES] as const;

export function childProtocolToolsForUncertainty(
  uncertaintyHandling: UncertaintyHandling,
): readonly string[] {
  return uncertaintyHandling === "ask-parent"
    ? CHILD_PROTOCOL_TOOL_NAMES
    : BASE_CHILD_PROTOCOL_TOOL_NAMES;
}

export type SubagentsCommand =
  | { action: "toggle" }
  | { action: "on" | "off" | "force-off" }
  | { action: "list" }
  | { action: "inspect"; delegationId?: string };

export interface PersistedSubagentState {
  mode: SubagentMode;
  agentName?: string;
  delegationId?: string;
  previous?: {
    provider?: string;
    model?: string;
    effort: string;
    tools: string[];
  };
}

export function parseSubagentsCommand(input: string): SubagentsCommand | undefined {
  const parts = input.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { action: "toggle" };
  const action = parts[0].toLowerCase();
  if (action === "list" && parts.length === 1) return { action };
  if (action === "inspect" && parts.length <= 2) {
    return { action, ...(parts[1] ? { delegationId: parts[1] } : {}) };
  }
  if (parts.length === 1 && (action === "on" || action === "off" || action === "force-off")) {
    return { action };
  }
  return undefined;
}

export function reconstructSubagentState(entries: readonly SessionEntry[]): PersistedSubagentState {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== "pi-tai-subagent-role") continue;
    const data = entry.data as Record<string, unknown> | undefined;
    if (data?.mode === "standalone" || data?.mode === "root" || data?.mode === "child") {
      return data as unknown as PersistedSubagentState;
    }
    // Version-2 compatibility.
    if (data?.role === "standalone" || data?.role === "parent" || data?.role === "child") {
      return {
        mode: data.role === "parent" ? "root" : data.role,
        ...(typeof data.delegationId === "string" ? { delegationId: data.delegationId } : {}),
      };
    }
  }
  return { mode: "standalone" };
}

export function activeToolsForMode(
  activeTools: readonly string[],
  mode: SubagentMode,
  configuredTools: readonly string[] = [],
): string[] {
  const roleTools = new Set<string>(ROLE_TOOL_NAMES);
  const base = activeTools.filter((name) => !roleTools.has(name));
  if (mode === "standalone") return [...new Set(base)];
  return [...new Set(configuredTools)];
}

export interface ComposeInstructionOptions {
  basePrompt: string;
  mode: SubagentMode;
  agentName?: string;
  systemInstructions: string;
  roleInstructions?: string;
  availableChildren?: readonly { name: string; description: string }[];
  delegation?: {
    id: string;
    parentSessionId: string;
    cwd: string;
  };
}

export function composePiTaiInstructions(options: ComposeInstructionOptions): string {
  const sections: string[] = [options.basePrompt];
  const system = options.systemInstructions.trim();
  if (system) sections.push(`<pi_tai_instructions>\n${system}\n</pi_tai_instructions>`);
  const role = options.roleInstructions?.trim();
  if (role) {
    sections.push(
      `<pi_tai_agent_instructions name="${escapeAttribute(options.agentName ?? options.mode)}">\n${role}\n</pi_tai_agent_instructions>`,
    );
  }
  if (options.mode !== "standalone") {
    const facts = [
      `<pi_tai_subagents mode="${options.mode}" agent="${escapeAttribute(options.agentName ?? "unknown")}">`,
      '<ingest conversation_history="none" cwd="shared" task_packet="self_contained" />',
    ];
    for (const child of options.availableChildren ?? []) {
      facts.push(
        `<allowed_child name="${escapeAttribute(child.name)}">${escapeText(child.description)}</allowed_child>`,
      );
    }
    if (options.delegation) {
      facts.push(
        `<delegation id="${escapeAttribute(options.delegation.id)}" parent_session_id="${escapeAttribute(options.delegation.parentSessionId)}" cwd="${escapeAttribute(options.delegation.cwd)}" />`,
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
