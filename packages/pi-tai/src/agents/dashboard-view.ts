/**
 * The `/subagents` dashboard: a fullscreen overlay listing every subagent this
 * session has started, with abort as the only action.
 *
 * Layout lives in {@link renderDashboard}; this file owns only the terminal
 * concerns — theme colours, keystrokes, and staying subscribed to the manager
 * so a running subagent's row updates without the user pressing anything.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TUI } from "@earendil-works/pi-tui";
import { clampSelection, renderDashboard, renderSubagentDetail, scrollDetail, type DashboardTone } from "./dashboard.ts";
import type { SubagentSnapshot } from "./domain.ts";

/**
 * The slice of {@link SubagentManager} the dashboard needs. Narrowing it keeps
 * the view constructible from a stub in tests and from nothing at all before
 * the agent runtime has been built.
 */
export interface DashboardAgents {
  list(): SubagentSnapshot[];
  subscribe(listener: (snapshot: SubagentSnapshot) => void): () => void;
  cancel(ids: readonly string[]): Promise<unknown>;
}

const TONE_COLOR: Record<DashboardTone, "border" | "accent" | "text" | "muted" | "error"> = {
  border: "border",
  accent: "accent",
  text: "text",
  muted: "muted",
  error: "error",
};

class SubagentDashboard {
  private readonly agents: DashboardAgents | undefined;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly close: () => void;
  private readonly unsubscribe: () => void;
  private snapshots: readonly SubagentSnapshot[];
  private selected = 0;
  private notice: string | undefined;
  private detailId: string | undefined;
  private detailScroll = 0;
  private detailMaxScroll = 0;

  constructor(options: {
    agents: DashboardAgents | undefined;
    tui: TUI;
    theme: Theme;
    close: () => void;
  }) {
    this.agents = options.agents;
    this.tui = options.tui;
    this.theme = options.theme;
    this.close = options.close;
    this.snapshots = this.agents?.list() ?? [];
    this.unsubscribe = this.agents?.subscribe(() => {
      this.snapshots = this.agents?.list() ?? [];
      this.selected = clampSelection(this.snapshots.length, this.selected);
      if (this.detailId && !this.snapshots.some((snapshot) => snapshot.id === this.detailId)) {
        const id = this.detailId;
        this.detailId = undefined;
        this.detailScroll = 0;
        this.notice = `${id} is no longer available.`;
      }
      this.tui.requestRender();
    }) ?? (() => {});
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      if (this.detailId) {
        this.detailId = undefined;
        this.detailScroll = 0;
        this.tui.requestRender();
      } else this.close();
      return;
    }
    if (matchesKey(data, "q") || matchesKey(data, "ctrl+c")) { this.close(); return; }
    if (matchesKey(data, "x")) { this.abort(); return; }
    if (this.detailId) {
      if (matchesKey(data, "j") || matchesKey(data, "down")) this.scroll("down");
      else if (matchesKey(data, "k") || matchesKey(data, "up")) this.scroll("up");
      else if (matchesKey(data, "ctrl+d")) this.scroll("pageDown");
      else if (matchesKey(data, "ctrl+u")) this.scroll("pageUp");
      else if (matchesKey(data, "g")) this.scroll("top");
      else if (matchesKey(data, "shift+g") || data === "G") this.scroll("bottom");
      return;
    }
    if (matchesKey(data, "enter")) {
      const target = this.snapshots[this.selected];
      if (target) { this.detailId = target.id; this.detailScroll = 0; this.notice = undefined; this.tui.requestRender(); }
      return;
    }
    if (matchesKey(data, "j") || matchesKey(data, "down")) this.move(1);
    else if (matchesKey(data, "k") || matchesKey(data, "up")) this.move(-1);
  }

  render(width: number): string[] {
    const detail = this.detailId ? this.snapshots.find((snapshot) => snapshot.id === this.detailId) : undefined;
    const rows = detail ? renderSubagentDetail({
      snapshot: detail, width, now: Date.now(), scroll: this.detailScroll,
      ...(this.notice ? { notice: this.notice } : {}),
    }) : undefined;
    if (rows) { this.detailScroll = rows.scroll; this.detailMaxScroll = rows.maxScroll; }
    return (rows?.rows ?? renderDashboard({
      snapshots: this.snapshots, selected: this.selected, width, now: Date.now(),
      ...(this.notice ? { notice: this.notice } : {}),
    })).map((row) => this.theme.fg(TONE_COLOR[row.tone], row.text));
  }

  invalidate(): void {}

  dispose(): void {
    this.unsubscribe();
  }

  private move(delta: number): void {
    this.selected = clampSelection(this.snapshots.length, this.selected + delta);
    this.tui.requestRender();
  }

  private scroll(command: "down" | "up" | "pageDown" | "pageUp" | "top" | "bottom"): void {
    this.detailScroll = scrollDetail(this.detailScroll, command, this.detailMaxScroll);
    this.tui.requestRender();
  }

  private abort(): void {
    const target = this.detailId
      ? this.snapshots.find((snapshot) => snapshot.id === this.detailId)
      : this.snapshots[this.selected];
    if (!target || !this.agents) return;
    if (target.status !== "running") {
      this.setNotice(`${target.id} has already finished.`);
      return;
    }
    this.setNotice(`Aborting ${target.id}…`);
    void this.agents.cancel([target.id]).then(
      () => this.setNotice(undefined),
      (error: unknown) => this.setNotice(error instanceof Error ? error.message : String(error)),
    );
  }

  private setNotice(notice: string | undefined): void {
    this.notice = notice;
    this.tui.requestRender();
  }
}

export function registerSubagentDashboard(
  pi: ExtensionAPI,
  resolveAgents: () => DashboardAgents | undefined,
): void {
  pi.registerCommand("subagents", {
    description: "Show running and finished subagents",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/subagents requires interactive TUI mode.", "error");
        return;
      }
      // The agent runtime is built lazily on first delegation. Opening the
      // dashboard is not a delegation, so an absent runtime renders as the
      // empty state rather than forcing an expensive construction.
      const agents = resolveAgents();
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new SubagentDashboard({ agents, tui, theme, close: () => done() }),
        {
          overlay: true,
          overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center", margin: 1 },
        },
      );
    },
  });
}
