import { basename, dirname } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface FooterUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface FooterSnapshot {
  cwd: string;
  capabilities: readonly string[];
  goal?: string;
  currentStep?: string;
  currentStepNumber?: number;
  totalSteps: number;
  usage: FooterUsage;
  contextWindow: number;
  contextPercent: number | null;
  usingSubscription: boolean;
  model: string;
  reasoning: boolean;
  thinkingLevel: string;
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

  const goalText = snapshot.goal?.replace(/^goal:\s*/i, "") || "No active goal";
  const goal = `Goal: ${goalText}`;
  const stepPrefix = snapshot.currentStepNumber
    ? `${snapshot.currentStepNumber}/${snapshot.totalSteps}`
    : `0/${snapshot.totalSteps}`;
  const step = `${stepPrefix}: ${snapshot.currentStep || "No active step"}`;
  const model = `${snapshot.model} · ${snapshot.thinkingLevel}`;
  const context =
    snapshot.contextPercent === null
      ? `?/${formatTokens(snapshot.contextWindow)} (auto)`
      : `${snapshot.contextPercent.toFixed(1)}%/${formatTokens(snapshot.contextWindow)} (auto)`;

  const usage: string[] = [];
  if (snapshot.usage.input) usage.push(`↑${formatTokens(snapshot.usage.input)}`);
  if (snapshot.usage.output) usage.push(`↓${formatTokens(snapshot.usage.output)}`);
  if (snapshot.usage.cacheRead) usage.push(`R${formatTokens(snapshot.usage.cacheRead)}`);
  if (snapshot.usage.cacheWrite) usage.push(`W${formatTokens(snapshot.usage.cacheWrite)}`);
  if (snapshot.usage.cost || snapshot.usingSubscription) {
    usage.push(`$${snapshot.usage.cost.toFixed(3)}${snapshot.usingSubscription ? " (sub)" : ""}`);
  }

  return [
    layoutRow(goal, model, width, "text"),
    layoutRow(step, context, width, "text"),
    layoutRow(
      [formatWorkspacePath(snapshot.cwd), ...snapshot.capabilities].join(" · "),
      usage.join(" "),
      width,
      "text",
    ),
  ];
}

export function footerRowText(row: FooterRow): string {
  return row.left + row.padding + row.right;
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
