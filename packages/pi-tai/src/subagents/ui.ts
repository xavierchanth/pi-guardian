import { createReadStream } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { createInterface } from "node:readline";
import { renderTaskPacket } from "./task.ts";
import { childReport, type DelegationRecord, type DelegationUsage } from "./store.ts";

const LOG_TAIL_BYTES = 1024 * 1024;

export type ChildUsage = DelegationUsage;

export interface TranscriptEntry {
  kind: "user" | "assistant" | "tool";
  text: string;
}

export interface ChildActivitySummary {
  record: DelegationRecord;
  activity: string;
}

export async function summarizeChildActivity(
  record: DelegationRecord,
): Promise<ChildActivitySummary> {
  const report = childReport(record);
  if (report) return { record, activity: lastNonemptyLine(report.summary) };
  if (record.execution.phase === "awaiting_parent") {
    return { record, activity: `Waiting for parent: ${record.execution.question.question}` };
  }
  if (record.execution.phase === "abandoned") {
    return { record, activity: record.execution.reason ?? "Abandoned by parent." };
  }
  const activity = record.childLogPath
    ? await latestAssistantLine(record.childLogPath)
    : undefined;
  return {
    record,
    activity: activity ?? (record.execution.phase === "created"
      ? "Starting child process…"
      : "Waiting for the first model update…"),
  };
}

export async function latestAssistantLine(logPath: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(logPath, "r");
    const info = await handle.stat();
    const length = Math.min(info.size, LOG_TAIL_BYTES);
    if (length === 0) return undefined;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (info.size > length) lines.shift();
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index]?.trim();
      if (!line) continue;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      const text = assistantText(frame);
      if (text) return lastNonemptyLine(text);
    }
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  } finally {
    await handle?.close();
  }
}

export function delegationTree(records: readonly DelegationRecord[], directParentSessionId: string): DelegationRecord[] {
  const children = new Map<string, DelegationRecord[]>();
  for (const record of records) {
    if (!record.parentDelegationId) continue;
    children.set(record.parentDelegationId, [...(children.get(record.parentDelegationId) ?? []), record]);
  }
  const result: DelegationRecord[] = [];
  const visit = (record: DelegationRecord) => {
    result.push(record);
    for (const child of (children.get(record.id) ?? []).sort(byCreatedAt)) visit(child);
  };
  for (const root of records.filter((record) => record.parentSessionId === directParentSessionId).sort(byCreatedAt)) visit(root);
  return result;
}

export function delegationDepth(record: DelegationRecord, records: readonly DelegationRecord[]): number {
  const byId = new Map(records.map((candidate) => [candidate.id, candidate]));
  let depth = 0;
  let parent = record.parentDelegationId;
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    depth += 1;
    parent = byId.get(parent)?.parentDelegationId;
  }
  return depth;
}

export function delegationTreePrefix(
  record: DelegationRecord,
  records: readonly DelegationRecord[],
  visibleRecords: readonly DelegationRecord[] = records,
): string {
  if (!record.parentDelegationId) return "";
  const byId = new Map(records.map((candidate) => [candidate.id, candidate]));
  const visibleIds = new Set(visibleRecords.map((candidate) => candidate.id));
  const ancestors: DelegationRecord[] = [];
  const seen = new Set([record.id]);
  let parentId: string | undefined = record.parentDelegationId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    ancestors.unshift(parent);
    parentId = parent.parentDelegationId;
  }
  const hasLaterVisibleSibling = (candidate: DelegationRecord): boolean => {
    const siblings = records
      .filter((item) => item.parentDelegationId === candidate.parentDelegationId && visibleIds.has(item.id))
      .sort(byCreatedAt);
    const index = siblings.findIndex((item) => item.id === candidate.id);
    return index >= 0 && index < siblings.length - 1;
  };
  return `${ancestors.slice(1).map((ancestor) => hasLaterVisibleSibling(ancestor) ? "│   " : "    ").join("")}${hasLaterVisibleSibling(record) ? "├── " : "└── "}`;
}

export async function readTranscript(logPath: string): Promise<TranscriptEntry[]> {
  const entries: TranscriptEntry[] = [];
  try {
    const lines = createInterface({ input: createReadStream(logPath, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      let frame: unknown;
      try { frame = JSON.parse(line); } catch { continue; }
      const candidate = frame as { type?: unknown; message?: unknown; toolName?: unknown; input?: unknown };
      if (candidate.type === "message_end" || candidate.type === "turn_end") {
        const message = visibleMessage(candidate.message);
        if (message && entries.at(-1)?.text !== message.text) entries.push(message);
      } else if (candidate.type === "tool_execution_start" && typeof candidate.toolName === "string") {
        entries.push({ kind: "tool", text: `${candidate.toolName} ${compactJson(candidate.input)}`.trim() });
      }
    }
  } catch { return []; }
  return entries;
}

export async function intrinsicUsage(logPath: string | undefined): Promise<ChildUsage> {
  const total = emptyUsage();
  if (!logPath) return total;
  try {
    const lines = createInterface({ input: createReadStream(logPath, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      let frame: any;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame?.type !== "message_end" || frame?.message?.role !== "assistant" || !frame.message.usage) continue;
      addUsage(total, frame.message.usage);
    }
  } catch { /* unavailable logs have zero attributable usage */ }
  return total;
}

export async function treeUsage(root: DelegationRecord, records: readonly DelegationRecord[]): Promise<ChildUsage> {
  const selected = new Set([root.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) if (record.parentDelegationId && selected.has(record.parentDelegationId) && !selected.has(record.id)) {
      selected.add(record.id); changed = true;
    }
  }
  const total = emptyUsage();
  for (const record of records) {
    if (!selected.has(record.id)) continue;
    addUsage(total, record.intrinsicUsage ?? await intrinsicUsage(record.childLogPath));
  }
  return total;
}

export function formatUsage(usage: ChildUsage): string {
  const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return `${tokens.toLocaleString()} tokens${usage.cost.total ? ` · $${usage.cost.total.toFixed(4)}` : ""}`;
}

export function finalVisibleAssistantText(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const text = messageText(messages[index]);
    if (text) return text;
  }
  return undefined;
}

export function formatChildDetail(summary: ChildActivitySummary): string {
  const { record, activity } = summary;
  const report = childReport(record);
  const sections = [
    `SUBAGENT\n${record.id}`,
    `AGENT\n${record.agent.name}`,
    `STATUS\n${record.execution.phase}`,
    `LATEST ACTIVITY\n${activity}`,
    `WORKING DIRECTORY\n${record.cwd}`,
    `MODEL\n${record.agent.provider}/${record.agent.model} · ${record.agent.effort}`,
    renderTaskPacket(record.task),
  ];
  if (record.workspace) {
    const workspace = record.workspace;
    sections.push([
      "WORKSPACE",
      `Backend: ${workspace.attachment.backend}`,
      `Name: ${workspace.attachment.name}`,
      `Phase: ${workspace.phase}`,
      `Base change: ${workspace.attachment.baseChangeId}`,
      `Root change: ${workspace.attachment.rootChangeId}`,
      ...(workspace.phase === "attention_required" ? [`STOPPED: ${workspace.reason}`] : []),
    ].join("\n"));
  }
  if (record.execution.phase === "awaiting_parent") {
    const question = record.execution.question;
    sections.push([
      "PARENT QUESTION",
      `${question.question} [${question.id}]`,
      ...(question.options?.length ? [`Options: ${question.options.join(", ")}`] : []),
      ...(question.recommendation ? [`Recommendation: ${question.recommendation}`] : []),
    ].join("\n"));
  }
  if (report) {
    sections.push([
      "REPORT",
      report.summary,
      ...(report.validation?.length ? ["Validation:", ...report.validation.map((item) => `- ${item}`)] : []),
      ...(report.changedFiles?.length ? ["Changed files:", ...report.changedFiles.map((item) => `- ${item}`)] : []),
      ...(report.concerns?.length ? ["Concerns:", ...report.concerns.map((item) => `- ${item}`)] : []),
    ].join("\n"));
  }
  sections.push([
    "RUNTIME",
    `PID: ${record.childPid ?? "unknown"}`,
    `Session: ${record.childSessionId ?? "not attached"}`,
    `Session file: ${record.childSessionFile ?? "not attached"}`,
    `Log: ${record.childLogPath ?? "unavailable"}`,
  ].join("\n"));
  return sections.join("\n\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ");
}

function assistantText(frame: unknown): string | undefined {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return undefined;
  const candidate = frame as {
    type?: unknown;
    message?: unknown;
    assistantMessageEvent?: { type?: unknown; content?: unknown; partial?: unknown };
  };
  if (candidate.type === "message_update") {
    return messageText(candidate.message)
      ?? (candidate.assistantMessageEvent?.type === "text_end"
        && typeof candidate.assistantMessageEvent.content === "string"
        ? candidate.assistantMessageEvent.content
        : undefined)
      ?? messageText(candidate.assistantMessageEvent?.partial);
  }
  if (candidate.type === "message_end" || candidate.type === "turn_end") {
    return messageText(candidate.message);
  }
  return undefined;
}

function visibleMessage(message: unknown): TranscriptEntry | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const role = (message as { role?: unknown }).role;
  if (role !== "user" && role !== "assistant") return undefined;
  const text = role === "assistant" ? messageText(message) : contentText(message);
  return text ? { kind: role, text } : undefined;
}

function contentText(message: unknown): string | undefined {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content.filter((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string")).map((part) => part.text).join("\n").trim();
  return text || undefined;
}

function messageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const candidate = message as { role?: unknown; content?: unknown };
  if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return undefined;
  const text = candidate.content
    .filter((part): part is { type: "text"; text: string } => Boolean(
      part && typeof part === "object" && !Array.isArray(part)
      && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string",
    ))
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text || undefined;
}

function lastNonemptyLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? text.trim();
}

function emptyUsage(): ChildUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function addUsage(total: ChildUsage, usage: any): void {
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    total[key] += usageAmount(usage?.[key]);
  }
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    total.cost[key] += usageAmount(usage?.cost?.[key]);
  }
}

function usageAmount(value: unknown): number {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) && amount >= 0 ? amount : 0;
}

function compactJson(value: unknown): string {
  if (value === undefined) return "";
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

function byCreatedAt(left: DelegationRecord, right: DelegationRecord): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}
