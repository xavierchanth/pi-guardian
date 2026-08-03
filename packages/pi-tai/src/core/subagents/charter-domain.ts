export const SUBAGENT_MODES = ["standalone", "root", "child"] as const;
export type SubagentMode = (typeof SUBAGENT_MODES)[number];

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
