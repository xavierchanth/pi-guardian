import { open, type FileHandle } from "node:fs/promises";
import { renderTaskPacket } from "./task.ts";
import { childReport, type DelegationRecord } from "./store.ts";

const LOG_TAIL_BYTES = 128 * 1024;

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
      ...(workspace.attachment.backend === "jj"
        ? [
            `Base change: ${workspace.attachment.baseChangeId}`,
            `Root change: ${workspace.attachment.rootChangeId}`,
          ]
        : [`Base commit: ${workspace.attachment.baseCommit}`, `Branch: ${workspace.attachment.branch}`]),
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
