/**
 * Pure layout for the `/subagents` dashboard.
 *
 * Rendering is kept free of terminal and manager access so the layout can be
 * asserted directly in unit tests; the view layer only maps tones onto theme
 * colours and forwards keystrokes.
 */

import { dashboardBodyCapacity } from "../dashboard/viewport.ts";
import { contextUtilisation, type SubagentSnapshot } from "./domain.ts";

export type DashboardTone = "border" | "accent" | "text" | "muted" | "error";

export interface DashboardRow {
  readonly text: string;
  readonly tone: DashboardTone;
}

export interface DashboardInput {
  readonly snapshots: readonly SubagentSnapshot[];
  /** Index of the highlighted row; clamped, so callers may hold a stale value. */
  readonly selected: number;
  readonly width: number;
  /** Epoch milliseconds, injected so elapsed times are deterministic under test. */
  readonly now: number;
  /** Total terminal row budget. Omit only for non-terminal compatibility callers. */
  readonly maxRows?: number;
  /** First item in the already reconciled virtual window. */
  readonly start?: number;
  readonly primaryTab?: "tasks" | "subagents" | "workspaces";
  readonly stateTab?: "current" | "archived";
  /** Transient feedback, such as why an abort failed. */
  readonly notice?: string;
}

export const DASHBOARD_TITLE = "Subagents";
export const DASHBOARD_HINT = "Enter inspect · j/k move · x abort · Esc close";
export const DETAIL_HINT = "j/k scroll · Ctrl+d/u page · g/G ends · Esc back · x abort";
export const DASHBOARD_EMPTY = "No subagents have been started in this session.";
export const DETAIL_BODY_HEIGHT = 12;

/** Below this the box drawing has no room left for content worth showing. */
const MIN_WIDTH = 24;

const STATUS_GLYPH: Record<SubagentSnapshot["status"], string> = {
  running: "●",
  done: "✓",
  error: "✗",
};

/**
 * Keeps a selection inside the list without the caller having to track
 * insertions and prunes, which happen on the manager's schedule rather than the
 * user's.
 */
export function clampSelection(count: number, index: number): number {
  if (count <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(0, Math.trunc(index)), count - 1);
}

export function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function renderDashboard(input: DashboardInput): DashboardRow[] {
  if (input.width < MIN_WIDTH) return [];
  const inner = input.width - 4;
  const selected = clampSelection(input.snapshots.length, input.selected);

  const capacity =
    input.maxRows === undefined
      ? Math.max(1, input.snapshots.length)
      : dashboardBodyCapacity(input.maxRows, Boolean(input.notice));
  const start = Math.max(0, Math.trunc(input.start ?? 0));
  const body: DashboardRow[] = input.snapshots.length
    ? input.snapshots.slice(start, start + capacity).map((snapshot, offset) => {
        const index = start + offset;
        return {
          text: entryText(snapshot, index === selected, inner, input.now),
          tone: rowTone(snapshot, index === selected),
        };
      })
    : capacity > 0
      ? [{ text: truncateToWidth(DASHBOARD_EMPTY, inner, "..."), tone: "muted" }]
      : [];

  const primary = input.primaryTab ?? "subagents";
  const state = input.stateTab ?? "current";
  return [
    { text: topBorder(input.width, `Dashboard · ${titleCase(primary)}`), tone: "border" },
    { text: frame(tabLine(["tasks", "subagents", "workspaces"], primary), inner), tone: "accent" },
    { text: frame(tabLine(["current", "archived"], state), inner), tone: "muted" },
    ...body.map((row) => ({ text: frame(row.text, inner), tone: row.tone })),

    ...(input.notice
      ? [
          {
            text: frame(truncateToWidth(input.notice, inner, "..."), inner),
            tone: "error" as const,
          },
        ]
      : []),
    { text: frame(truncateToWidth(DASHBOARD_HINT, inner, "..."), inner), tone: "muted" },
    { text: bottomBorder(input.width), tone: "border" },
  ];
}

export interface DetailInput {
  readonly snapshot: SubagentSnapshot;
  readonly width: number;
  readonly now: number;
  readonly scroll: number;
  readonly bodyHeight?: number;
  /** Total terminal rows; when supplied the complete detail is one bounded viewport. */
  readonly maxRows?: number;
  readonly notice?: string;
}

export interface DetailRender {
  readonly rows: readonly DashboardRow[];
  readonly scroll: number;
  readonly maxScroll: number;
}

/** Pure detail layout. Output is explicitly a current snapshot, not a transcript. */
export function renderSubagentDetail(input: DetailInput): DetailRender {
  if (input.width < MIN_WIDTH) return { rows: [], scroll: 0, maxScroll: 0 };
  const inner = input.width - 4;
  const s = input.snapshot;
  const context = contextUtilisation(s);
  const output = s.status === "running" ? s.latestText : s.finalText;
  const outputLines = (output || "(No assistant output yet.)").split(/\r?\n/);
  const bodyHeight = Math.max(1, input.bodyHeight ?? DETAIL_BODY_HEIGHT);
  const maxScroll = Math.max(0, outputLines.length - bodyHeight);
  const scroll = Math.min(Math.max(0, Math.trunc(input.scroll)), maxScroll);
  const fields = [
    `ID: ${s.id}  Title: ${s.title}`,
    `Backend: ${s.backend}  Model: ${s.model ?? "--"}  Capability: ${s.capability ?? "--"}`,
    `Status: ${s.status}  Elapsed: ${formatElapsed(elapsedMs(s, input.now))}  Turns: ${s.turns}`,
    `Tokens: ${s.usage.inputTokens} in / ${s.usage.outputTokens} out  Context: ${context === undefined ? "--" : `${context}%`} (${s.usage.contextWindow ?? "unknown"})`,
    `CWD: ${s.cwd}`,
    `Workspace: ${s.workspaceId ?? "--"}`,
    `Started: ${s.createdAt}  Settled: ${s.settledAt ?? "--"}`,
    ...(s.liveTools.length
      ? [
          "Tools:",
          ...s.liveTools.map(
            (tool) => `  ${tool.state} ${tool.name}${tool.preview ? ` — ${tool.preview}` : ""}`,
          ),
        ]
      : ["Tools: none"]),
    ...(s.errorText ? [`Error: ${s.errorText}`] : []),
    "",
    `Current snapshot output (${s.status === "running" ? "live/latest" : "settled/final"}; not a durable full transcript)`,
  ];
  const body = outputLines.slice(scroll, scroll + bodyHeight);
  const position = `Lines ${outputLines.length ? scroll + 1 : 0}-${Math.min(outputLines.length, scroll + bodyHeight)} of ${outputLines.length}`;
  let content = [...fields, ...body, position];
  let viewportScroll = scroll;
  let viewportMax = maxScroll;
  if (input.maxRows !== undefined) {
    const capacity = Math.max(0, Math.trunc(input.maxRows) - 3 - (input.notice ? 1 : 0));
    const complete = [
      ...fields,
      ...outputLines,
      `Lines 1-${outputLines.length} of ${outputLines.length}`,
    ];
    viewportMax = Math.max(0, complete.length - capacity);
    viewportScroll = Math.min(Math.max(0, Math.trunc(input.scroll)), viewportMax);
    content = complete.slice(viewportScroll, viewportScroll + capacity);
  }
  const rows: DashboardRow[] = [
    { text: topBorder(input.width, `Subagent ${s.id}`), tone: "border" },
    ...content.map((text) => ({
      text: frame(truncateToWidth(text, inner, "..."), inner),
      tone: "text" as const,
    })),
    ...(input.notice
      ? [
          {
            text: frame(truncateToWidth(input.notice, inner, "..."), inner),
            tone: "error" as const,
          },
        ]
      : []),
    { text: frame(truncateToWidth(DETAIL_HINT, inner, "..."), inner), tone: "muted" },
    { text: bottomBorder(input.width), tone: "border" },
  ];
  return { rows, scroll: viewportScroll, maxScroll: viewportMax };
}

export function scrollDetail(
  current: number,
  command: "down" | "up" | "pageDown" | "pageUp" | "top" | "bottom",
  max: number,
  page = DETAIL_BODY_HEIGHT,
): number {
  const delta =
    command === "down"
      ? 1
      : command === "up"
        ? -1
        : command === "pageDown"
          ? page
          : command === "pageUp"
            ? -page
            : 0;
  if (command === "top") return 0;
  if (command === "bottom") return Math.max(0, max);
  return Math.min(Math.max(0, current + delta), Math.max(0, max));
}

/** Flattens rows for callers that only need text, chiefly tests. */
export function dashboardText(rows: readonly DashboardRow[]): string[] {
  return rows.map((row) => row.text);
}

function entryText(
  snapshot: SubagentSnapshot,
  selected: boolean,
  width: number,
  now: number,
): string {
  const left = `${selected ? "›" : " "} ${STATUS_GLYPH[snapshot.status]} ${snapshot.title} ${snapshot.id}`;
  const context = contextUtilisation(snapshot);
  const right = [
    snapshot.model ?? snapshot.backend,
    `ctx ${context === undefined ? "--" : `${context}%`}`,
    formatElapsed(elapsedMs(snapshot, now)),
    snapshot.status,
  ].join("  ");

  const rightWidth = visibleWidth(right);
  if (rightWidth + 4 >= width) return truncateToWidth(left, width, "...");
  const renderedLeft = truncateToWidth(left, width - rightWidth - 2, "...");
  const padding = " ".repeat(Math.max(2, width - visibleWidth(renderedLeft) - rightWidth));
  return `${renderedLeft}${padding}${right}`;
}

function elapsedMs(snapshot: SubagentSnapshot, now: number): number {
  const started = Date.parse(snapshot.createdAt);
  if (Number.isNaN(started)) return 0;
  const ended = snapshot.settledAt ? Date.parse(snapshot.settledAt) : now;
  return (Number.isNaN(ended) ? now : ended) - started;
}

function rowTone(snapshot: SubagentSnapshot, selected: boolean): DashboardTone {
  if (selected) return "accent";
  return snapshot.status === "error" ? "error" : "text";
}

function frame(text: string, inner: number): string {
  const padded = text + " ".repeat(Math.max(0, inner - visibleWidth(text)));
  return `│ ${padded} │`;
}

function topBorder(width: number, title = DASHBOARD_TITLE): string {
  const label = ` ${title} `;
  return `┌─${label}${"─".repeat(Math.max(0, width - 3 - visibleWidth(label)))}┐`;
}

function tabLine<T extends string>(tabs: readonly T[], active: T): string {
  return tabs
    .map((tab) => (tab === active ? `[${titleCase(tab)}]` : ` ${titleCase(tab)} `))
    .join("  ");
}

function titleCase(value: string): string {
  return value[0]?.toUpperCase() + value.slice(1);
}

function visibleWidth(value: string): number {
  return Array.from(value).length;
}

function truncateToWidth(value: string, width: number, suffix = ""): string {
  if (visibleWidth(value) <= width) return value;
  if (width <= 0) return "";
  const ending = Array.from(suffix).slice(0, width).join("");
  return (
    Array.from(value)
      .slice(0, Math.max(0, width - visibleWidth(ending)))
      .join("") + ending
  );
}

function bottomBorder(width: number): string {
  return `└${"─".repeat(Math.max(0, width - 2))}┘`;
}
