import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { ROLE_TOOL_NAMES } from "./domain.ts";

const PRESENTED_TOOLS = new Set<string>(ROLE_TOOL_NAMES);
const MAX_COMPACT_TEXT = 240;
const MAX_EXPANDED_TEXT = 4_000;

interface ToolDefinitionLike {
  readonly name: string;
  readonly label: string;
  readonly renderCall?: (...args: any[]) => unknown;
  readonly [key: string]: unknown;
}

/** Adds bounded semantic call rendering to production subagent tools without changing execution. */
export function withSubagentToolPresentation(pi: ExtensionAPI): ExtensionAPI {
  const registerTool = pi.registerTool.bind(pi);
  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") {
        return (tool: ToolDefinitionLike) => {
          if (!PRESENTED_TOOLS.has(tool.name) || tool.renderCall) {
            registerTool(tool as any);
            return;
          }
          registerTool({
            ...tool,
            renderCall(args: unknown, theme: any, context: { expanded: boolean; lastComponent?: unknown }) {
              const component = context.lastComponent instanceof Text
                ? context.lastComponent
                : new Text("", 0, 0);
              component.setText(renderSubagentToolCall(tool.name, tool.label, args, context.expanded, theme));
              return component;
            },
          } as any);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function formatSubagentToolCall(
  name: string,
  label: string,
  args: unknown,
  expanded: boolean,
): string {
  return renderSubagentToolCall(name, label, args, expanded);
}

function renderSubagentToolCall(
  name: string,
  label: string,
  args: unknown,
  expanded: boolean,
  theme?: { bold(value: string): string; fg(color: "toolTitle" | "muted" | "dim", value: string): string },
): string {
  const record = object(args);
  const title = theme ? theme.fg("toolTitle", theme.bold(label)) : label;
  const summary = callSummary(name, record);
  const lines = [summary ? `${title} ${theme ? theme.fg("muted", summary) : summary}` : title];
  if (expanded) {
    const details = expandedDetails(name, record);
    if (details.length) lines.push(...details.map((line) => theme ? theme.fg("dim", line) : line));
  }
  return lines.join("\n");
}

function callSummary(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "work_order_create": return separator([text(args.executionClass), text(args.objective)]);
    case "work_order_revise": return separator([firstMeaningfulLine(rawText(args.instructions)), text(args.rationale)]);
    case "work_order_record_user_direction": return text(args.summary);
    case "subagent": return separator([text(args.agent), text(object(args.task).objective)]);
    case "workspace_subagent": return shortIdentity(args.workOrderId);
    case "message_child": return separator([shortIdentity(args.delegationId), text(args.delivery) || "steer", text(args.message)]);
    case "request_child_status": return separator([shortIdentity(args.contextId), text(args.focus) || "bounded status"]);
    case "respond_to_child": return separator([shortIdentity(args.delegationId), text(args.response)]);
    case "message_parent": return separator([text(args.kind), text(args.summary)]);
    case "report_status": return separator([shortIdentity(args.requestId), text(args.current) || text(args.summary)]);
    case "ask_parent": return text(args.question);
    case "report_to_parent": return separator([text(args.outcome), text(args.summary)]);
    case "insert_change":
    case "assign_workspace_change": return separator([shortIdentity(args.ownerContextId), text(args.description)]);
    case "workspace_checkpoint": return text(args.description);
    case "acquire_file_set":
    case "acquire_workspace_file_set": return countSummary(args.paths, "path");
    case "normalize_change_range": return separator([shortIdentity(args.delegationId), countSummary(args.descriptions, "description")]);
    case "rebase_workspace": return separator([shortIdentity(args.delegationId), args.targetChangeId ? `onto ${shortIdentity(args.targetChangeId)}` : "onto source @-"]);
    case "submit_workspace_review": return separator([countSummary(args.findings, "finding"), text(args.summary)]);
    case "accept_workspace_review": return separator([shortIdentity(args.delegationId), countSummary(args.dispositions, "disposition")]);
    case "start_review_repair": return separator([shortIdentity(args.delegationId), text(args.objective) || "blocking findings"]);
    case "reconcile_integration_conflicts": return separator([shortIdentity(args.delegationId), countSummary(args.paths, "path")]);
    case "verify_integrated_range": return separator([shortIdentity(args.delegationId), countSummary(args.productChecks, "check")]);
    case "describe_integrated_changes": return separator([shortIdentity(args.delegationId), countSummary(args.changes, "change")]);
    case "workspace_custody_status":
    case "workspace_recovery_plan": return shortIdentity(args.workspaceId);
    case "reconcile_workspace": return separator([shortIdentity(args.workspaceId), shortIdentity(args.actionId)]);
    case "rebind_tracked_change": return separator([shortIdentity(args.delegationId), text(args.kind), shortIdentity(args.replacementChangeId)]);
    case "await_child_event": return separator([identityCount(args.contextIds, "child", "all children"), arrayValues(args.kinds).join(", ") || "questions/terminal/incidents", duration(args.timeoutMs)]);
    case "ack_child_event": return separator([shortIdentity(args.contextId), shortIdentity(args.eventId)]);
    case "concurrency_usage": return args.contextId ? shortIdentity(args.contextId) : "all children";
  }

  const target = shortIdentity(args.delegationId ?? args.contextId ?? args.workspaceId);
  const primary = text(args.objective ?? args.description ?? args.summary ?? args.question ?? args.message);
  return separator([target, primary]);
}

function expandedDetails(name: string, args: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const skip = new Set(["ownerRole", "agent", "delivery", "kind", "outcome"]);
  for (const [key, value] of Object.entries(args)) {
    if (skip.has(key) || value === undefined) continue;
    if (key === "directionIds") {
      lines.push(`Directions: ${arrayValues(value).length}`);
      continue;
    }
    if (key === "instructions") {
      const instructionLines = rawText(value).split(/\r?\n/).filter((line) => line.trim()).slice(0, 24);
      if (instructionLines.length) lines.push("Instructions:", ...instructionLines.map((line) => `  ${bounded(line)}`));
      continue;
    }
    if (key === "task") {
      lines.push(...taskDetails(object(value)));
      continue;
    }
    const label = fieldLabel(key);
    if (Array.isArray(value)) {
      if (!value.length) continue;
      lines.push(`${label}:`);
      for (const item of value.slice(0, 16)) lines.push(`  • ${bounded(itemText(item))}`);
      if (value.length > 16) lines.push(`  … ${value.length - 16} more`);
      continue;
    }
    if (typeof value === "object" && value !== null) {
      lines.push(`${label}: ${bounded(JSON.stringify(value))}`);
      continue;
    }
    lines.push(`${label}: ${bounded(String(value))}`);
  }
  if (name === "work_order_status" && lines.length === 0) lines.push("Role-scoped durable work-order projection");
  return lines.slice(0, 32);
}

function taskDetails(task: Record<string, unknown>): string[] {
  const lines = [`Objective: ${bounded(rawText(task.objective))}`];
  for (const key of ["context", "resources", "constraints", "acceptanceCriteria"] as const) {
    const values = arrayValues(task[key]);
    if (!values.length) continue;
    lines.push(`${fieldLabel(key)}:`);
    for (const value of values.slice(0, 12)) lines.push(`  • ${bounded(itemText(value))}`);
    if (values.length > 12) lines.push(`  … ${values.length - 12} more`);
  }
  if (rawText(task.expectedOutput)) lines.push(`Expected output: ${bounded(rawText(task.expectedOutput))}`);
  if (rawText(task.uncertaintyHandling)) lines.push(`Uncertainty: ${text(task.uncertaintyHandling)}`);
  return lines;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function rawText(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function text(value: unknown): string {
  const normalized = rawText(value).replace(/\s+/g, " ");
  return normalized.length <= MAX_COMPACT_TEXT ? normalized : `${normalized.slice(0, MAX_COMPACT_TEXT - 1)}…`;
}
function arrayValues(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function itemText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return String(value);
  const record = value as Record<string, unknown>;
  return separator([
    text(record.findingId ?? record.changeId ?? record.type),
    text(record.value),
    text(record.severity ?? record.disposition),
    text(record.summary ?? record.description ?? record.objective ?? record.reason),
  ]) || JSON.stringify(value);
}
function separator(values: readonly string[]): string { return values.filter(Boolean).join(" · "); }
function firstMeaningfulLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
}
function bounded(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= MAX_EXPANDED_TEXT ? normalized : `${normalized.slice(0, MAX_EXPANDED_TEXT - 1)}…`;
}
function shortIdentity(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  if (value.length <= 20) return value;
  const firstSegment = value.split("-", 1)[0] ?? "";
  const prefix = firstSegment && !/^[a-f0-9]{8}$/i.test(firstSegment) ? `${firstSegment}-` : "";
  return `${prefix}${value.slice(prefix.length, prefix.length + 8)}…`;
}
function countSummary(value: unknown, noun: string): string {
  const count = arrayValues(value).length;
  return count ? `${count} ${noun}${count === 1 ? "" : "s"}` : "";
}
function identityCount(value: unknown, noun: string, fallback: string): string {
  const count = arrayValues(value).length;
  return count ? `${count} ${noun}${count === 1 ? "" : "ren"}` : fallback;
}
function duration(value: unknown): string {
  return typeof value === "number" ? `${Math.round(value / 1_000)}s` : "";
}
function fieldLabel(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase());
}
