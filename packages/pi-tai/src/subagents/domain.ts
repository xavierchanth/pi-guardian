import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const SUBAGENT_MODES = ["standalone", "root", "child"] as const;
export type SubagentMode = (typeof SUBAGENT_MODES)[number];

export const PARENT_TOOL_NAMES = [
  "subagent",
  "message_child",
  "wait_for_children",
  "child_status",
  "respond_to_child",
  "abandon_child",
  "planner_workspace",
  "integrate_planner_workspace",
  "cleanup_planner_workspace",
] as const;
export const CHILD_PROTOCOL_TOOL_NAMES = ["report_to_parent", "ask_parent"] as const;
export const ROLE_TOOL_NAMES = [...PARENT_TOOL_NAMES, ...CHILD_PROTOCOL_TOOL_NAMES] as const;

export type SubagentsCommand =
  | { action: "toggle" }
  | { action: "on" | "off" | "force-off" | "status" }
  | { action: "list"; delegationId?: string };

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
  if (action === "list" && parts.length <= 2) {
    return { action, ...(parts[1] ? { delegationId: parts[1] } : {}) };
  }
  if (
    parts.length === 1
    && (action === "on" || action === "off" || action === "force-off" || action === "status")
  ) {
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
