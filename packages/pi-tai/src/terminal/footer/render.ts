import { basename, dirname } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentActivitySummary } from "../../core/subagents/activity.ts";

export interface FooterUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface FooterSnapshot {
  cwd: string;
  usage: FooterUsage;
  contextWindow: number;
  contextPercent: number | null;
  usingSubscription: boolean;
  model: string;
  reasoning: boolean;
  thinkingLevel: string;
  subagents: SubagentActivitySummary;
}

export interface FooterRow {
  left: string;
  padding: string;
  right: string;
  leftColor: "accent" | "text";
}

export function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export function formatWorkspacePath(cwd: string): string {
  const current = basename(cwd);
  const parent = basename(dirname(cwd));
  if (!current) return cwd;
  if (!parent || parent === current) return current;
  return `${parent}/${current}`;
}

export function renderFooterRows(snapshot: FooterSnapshot, width: number): FooterRow[] {
  if (width <= 0) return [];

  const latest = snapshot.subagents.latest;
  // Activity ultimately originates in model/tool text. Sanitize again at the
  // presentation boundary so alternate providers cannot inject terminal controls.
  const activity = latest
    ? `${sanitizeFooterText(latest.displayId)} · ${sanitizeFooterText(latest.activity)}`
    : "No subagent activity";
  const { running, done, error } = snapshot.subagents.totals;
  const totals = `Subagents: ${running} running · ${done} done · ${error} error`;
  const model = `${snapshot.model} · ${snapshot.thinkingLevel}`;
  const context =
    snapshot.contextPercent === null
      ? `?/${formatTokens(snapshot.contextWindow)}`
      : `${snapshot.contextPercent.toFixed(1)}%/${formatTokens(snapshot.contextWindow)}`;

  const usage: string[] = [];
  if (snapshot.usage.input) usage.push(`↑${formatTokens(snapshot.usage.input)}`);
  if (snapshot.usage.output) usage.push(`↓${formatTokens(snapshot.usage.output)}`);
  if (snapshot.usage.cacheRead) usage.push(`R${formatTokens(snapshot.usage.cacheRead)}`);
  if (snapshot.usage.cacheWrite) usage.push(`W${formatTokens(snapshot.usage.cacheWrite)}`);
  if (snapshot.usage.cost || snapshot.usingSubscription) {
    usage.push(
      `$${snapshot.usage.cost.toFixed(3)}${snapshot.usingSubscription ? " (sub)" : " (api)"}`,
    );
  }

  return [
    layoutRow(activity, model, width, "text"),
    layoutRow(totals, context, width, "text"),
    layoutRow(formatWorkspacePath(snapshot.cwd), usage.join(" "), width, "text"),
  ];
}

export function footerRowText(row: FooterRow): string {
  return row.left + row.padding + row.right;
}

export function sanitizeFooterText(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function layoutRow(
  left: string,
  right: string,
  width: number,
  leftColor: FooterRow["leftColor"],
): FooterRow {
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) {
    return {
      left: "",
      padding: "",
      right: truncateToWidth(right, width, ""),
      leftColor,
    };
  }

  if (!right) {
    return {
      left: truncateToWidth(left, width, "..."),
      padding: "",
      right: "",
      leftColor,
    };
  }

  const availableLeft = Math.max(0, width - rightWidth - 2);
  const renderedLeft = truncateToWidth(left, availableLeft, "...");
  const padding = " ".repeat(Math.max(2, width - visibleWidth(renderedLeft) - rightWidth));
  return { left: renderedLeft, padding, right, leftColor };
}
