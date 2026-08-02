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
import {
  type DashboardPrimaryTab,
  type DashboardStateTab,
  dashboardBodyCapacity,
  ensureVisible,
  moveSelection,
  reconcileSelection,
} from "../../core/dashboard/viewport.ts";
import {
  type DashboardTone,
  renderDashboard,
  renderSubagentDetail,
  scrollDetail,
} from "../../core/subagents/dashboard.ts";
import type { SubagentSnapshot } from "../../core/subagents/domain.ts";

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

export const OVERLAY_MARGIN = 1;

const PRIMARY_TAB_ORDER: readonly DashboardPrimaryTab[] = ["tasks", "subagents", "workspaces"];
const STATE_TAB_ORDER: readonly DashboardStateTab[] = ["current", "archived"];

export type DashboardInputMode = "normal" | "detail" | "search" | "marks";
export type DashboardAction =
  | "close"
  | "quit"
  | "primaryNext"
  | "primaryPrevious"
  | "stateNext"
  | "statePrevious"
  | "taskEdit"
  | "subagentDetail"
  | "workspaceCustodyDetail"
  | "actionMenu"
  | "cancel"
  | "taskImportRevision"
  | "archiveRestore"
  | "mark"
  | "markAll"
  | "jumpSubagent"
  | "jumpWorkspace"
  | "search"
  | "help"
  | "down"
  | "up"
  | "pageDown"
  | "pageUp"
  | "top"
  | "bottom";

/** Pure §4.8 contextual dispatch table. Input modes consume text first. */
export function resolveAction(
  data: string,
  mode: DashboardInputMode,
  tab: DashboardPrimaryTab,
): DashboardAction | undefined {
  if (mode === "search" || mode === "marks")
    return matchesKey(data, "escape") ? "close" : undefined;
  if (matchesKey(data, "escape")) return "close";
  if (matchesKey(data, "q") || matchesKey(data, "ctrl+c")) return "quit";
  if (matchesKey(data, "j") || matchesKey(data, "down")) return "down";
  if (matchesKey(data, "k") || matchesKey(data, "up")) return "up";
  if (matchesKey(data, "ctrl+d") || data === "\x1b[6~") return "pageDown";
  if (matchesKey(data, "ctrl+u") || data === "\x1b[5~") return "pageUp";
  if (matchesKey(data, "g")) return "top";
  if (matchesKey(data, "shift+g") || data === "G") return "bottom";
  if (mode !== "detail" && (matchesKey(data, "l") || matchesKey(data, "right")))
    return "primaryNext";
  if (mode !== "detail" && (matchesKey(data, "h") || matchesKey(data, "left")))
    return "primaryPrevious";
  if (matchesKey(data, "tab")) return "stateNext";
  if (matchesKey(data, "shift+tab")) return "statePrevious";
  if (matchesKey(data, "enter") || matchesKey(data, "i"))
    return tab === "tasks"
      ? "taskEdit"
      : tab === "subagents"
        ? "subagentDetail"
        : "workspaceCustodyDetail";
  if (matchesKey(data, "a")) return "actionMenu";
  if (matchesKey(data, "x")) return "cancel";
  if (matchesKey(data, "p")) return tab === "tasks" ? "taskImportRevision" : undefined;
  if (matchesKey(data, "e")) return tab === "workspaces" ? undefined : "archiveRestore";
  if (matchesKey(data, "v")) return "mark";
  if (data === "V") return "markAll";
  if (matchesKey(data, "s")) return tab === "subagents" ? undefined : "jumpSubagent";
  if (matchesKey(data, "w")) return tab === "workspaces" ? undefined : "jumpWorkspace";
  if (matchesKey(data, "/")) return "search";
  if (matchesKey(data, "?")) return "help";
  return undefined;
}

function title(tab: DashboardPrimaryTab): string {
  return tab[0]!.toUpperCase() + tab.slice(1);
}

function footerHint(tab: DashboardPrimaryTab): string {
  const contextual = tab === "subagents" ? " · Enter inspect · x cancel" : "";
  return `h/l tabs · Tab current/archived · j/k move${contextual} · Esc close`;
}

function unavailableNotice(action: DashboardAction, tab: DashboardPrimaryTab): string {
  const names: Partial<Record<DashboardAction, string>> = {
    actionMenu: "Action menu",
    taskImportRevision: "Fixed task revision import",
    archiveRestore: "Archive/restore",
    mark: "Mark",
    markAll: "Mark all",
    jumpSubagent: "Jump to subagent",
    jumpWorkspace: "Jump to workspace",
    search: "Search",
    help: "Help",
  };
  return `${names[action] ?? action} is not available on ${title(tab)} yet.`;
}

const TONE_COLOR: Record<DashboardTone, "border" | "accent" | "text" | "muted" | "error"> = {
  border: "border",
  accent: "accent",
  text: "text",
  muted: "muted",
  error: "error",
};

export class SubagentDashboard {
  private readonly agents: DashboardAgents | undefined;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly close: () => void;
  private readonly readRows: (tui: TUI) => number;
  private readonly unsubscribe: () => void;
  private snapshots: readonly SubagentSnapshot[];
  private disposed = false;
  private generation = 0;
  private selectedId: string | undefined;
  private selectedIndex = 0;
  private viewportStart = 0;
  private primaryTab: DashboardPrimaryTab = "subagents";
  private stateTab: DashboardStateTab = "current";
  private notice: string | undefined;
  private detailId: string | undefined;
  private detailScroll = 0;
  private detailMaxScroll = 0;

  constructor(options: {
    agents: DashboardAgents | undefined;
    tui: TUI;
    theme: Theme;
    close: () => void;
    readRows: (tui: TUI) => number;
  }) {
    this.agents = options.agents;
    this.tui = options.tui;
    this.theme = options.theme;
    this.close = options.close;
    this.readRows = options.readRows;
    this.snapshots = this.currentRows();
    this.selectedId = this.snapshots[0]?.id;
    this.unsubscribe = this.agents?.subscribe(() => this.reload()) ?? (() => {});
  }

  focus(tab: DashboardPrimaryTab): void {
    this.primaryTab = tab;
    this.detailId = undefined;
    this.notice = undefined;
    this.viewportStart = 0;
    this.selectedId = undefined;
    this.selectedIndex = 0;
    this.reload();
  }

  handleInput(data: string): void {
    const action = resolveAction(data, this.detailId ? "detail" : "normal", this.primaryTab);
    if (!action) return;
    if (action === "close") {
      if (this.detailId) {
        this.detailId = undefined;
        this.detailScroll = 0;
        this.requestRender();
      } else this.close();
    } else if (action === "quit") this.close();
    else if (action === "cancel") {
      if (this.primaryTab === "subagents") this.abort();
      else this.setNotice(`Cancel is not available on ${title(this.primaryTab)} yet.`);
    } else if (action === "primaryNext" || action === "primaryPrevious") {
      const index = PRIMARY_TAB_ORDER.indexOf(this.primaryTab);
      const next = index + (action === "primaryNext" ? 1 : -1);
      if (next >= 0 && next < PRIMARY_TAB_ORDER.length) this.focus(PRIMARY_TAB_ORDER[next]!);
    } else if (action === "stateNext" || action === "statePrevious") {
      const index = STATE_TAB_ORDER.indexOf(this.stateTab);
      this.stateTab = STATE_TAB_ORDER[(index + (action === "stateNext" ? 1 : -1) + 2) % 2]!;
      this.notice = undefined;
      this.viewportStart = 0;
      this.reload();
    } else if (action === "subagentDetail") {
      const target = this.snapshots.find((row) => row.id === this.selectedId);
      if (target) {
        this.detailId = target.id;
        this.detailScroll = 0;
        this.notice = undefined;
        this.requestRender();
      } else this.setNotice("Subagent detail is unavailable because no subagent is selected.");
    } else if (action === "taskEdit")
      this.setNotice("Task editing is unavailable until the Tasks adapter is connected.");
    else if (action === "workspaceCustodyDetail")
      this.setNotice(
        "Workspace custody detail is unavailable until the Workspaces adapter is connected.",
      );
    else if (action === "down") this.detailId ? this.scroll("down") : this.move(1);
    else if (action === "up") this.detailId ? this.scroll("up") : this.move(-1);
    else if (["pageDown", "pageUp", "top", "bottom"].includes(action))
      this.detailId
        ? this.scroll(action as "pageDown" | "pageUp" | "top" | "bottom")
        : this.navigateList(action as "pageDown" | "pageUp" | "top" | "bottom");
    else this.setNotice(unavailableNotice(action, this.primaryTab));
  }

  render(width: number): string[] {
    const rowBudget = Math.max(0, this.readRows(this.tui) - OVERLAY_MARGIN * 2);
    const detail = this.detailId
      ? this.snapshots.find((snapshot) => snapshot.id === this.detailId)
      : undefined;
    const rows = detail
      ? renderSubagentDetail({
          snapshot: detail,
          width,
          now: Date.now(),
          scroll: this.detailScroll,
          maxRows: rowBudget,
          ...(this.notice ? { notice: this.notice } : {}),
        })
      : undefined;
    if (rows) {
      this.detailScroll = rows.scroll;
      this.detailMaxScroll = rows.maxScroll;
    }
    if (rows)
      return rows.rows
        .slice(0, rowBudget)
        .map((row) => this.theme.fg(TONE_COLOR[row.tone], row.text));
    const ids = this.snapshots.map((snapshot) => snapshot.id);
    const emptyMessage =
      this.primaryTab === "subagents"
        ? this.stateTab === "archived"
          ? "Archived subagent data is not available from the synchronous session source."
          : undefined
        : `${title(this.primaryTab)} data is unavailable until its adapter is connected.`;
    const viewport = ensureVisible(
      ids,
      this.selectedId,
      dashboardBodyCapacity(rowBudget, Boolean(this.notice)),
      this.viewportStart,
    );
    this.viewportStart = viewport.start;
    return renderDashboard({
      snapshots: this.primaryTab === "subagents" ? this.snapshots : [],
      selected: Math.max(0, ids.indexOf(this.selectedId ?? "")),
      width,
      now: Date.now(),
      maxRows: rowBudget,
      start: viewport.start,
      primaryTab: this.primaryTab,
      stateTab: this.stateTab,
      ...(this.notice ? { notice: this.notice } : {}),
      ...(emptyMessage ? { emptyMessage } : {}),
      hint: footerHint(this.primaryTab),
    })
      .slice(0, rowBudget)
      .map((row) => this.theme.fg(TONE_COLOR[row.tone], row.text));
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.unsubscribe();
  }

  private move(delta: number): void {
    const ids = this.snapshots.map((snapshot) => snapshot.id);
    this.selectedId = moveSelection(ids, this.selectedId, delta);
    this.selectedIndex = Math.max(0, ids.indexOf(this.selectedId ?? ""));
    this.requestRender();
  }

  private navigateList(command: "pageDown" | "pageUp" | "top" | "bottom"): void {
    const ids = this.snapshots.map((row) => row.id);
    if (!ids.length) return;
    const capacity = Math.max(
      1,
      dashboardBodyCapacity(
        Math.max(0, this.readRows(this.tui) - OVERLAY_MARGIN * 2),
        Boolean(this.notice),
      ),
    );
    const current = Math.max(0, ids.indexOf(this.selectedId ?? ""));
    const next =
      command === "top"
        ? 0
        : command === "bottom"
          ? ids.length - 1
          : Math.min(
              ids.length - 1,
              Math.max(0, current + (command === "pageDown" ? capacity : -capacity)),
            );
    this.selectedId = ids[next];
    this.selectedIndex = next;
    this.requestRender();
  }

  private scroll(command: "down" | "up" | "pageDown" | "pageUp" | "top" | "bottom"): void {
    this.detailScroll = scrollDetail(this.detailScroll, command, this.detailMaxScroll);
    this.tui.requestRender();
  }

  private abort(): void {
    const target = this.detailId
      ? this.snapshots.find((snapshot) => snapshot.id === this.detailId)
      : this.snapshots.find((snapshot) => snapshot.id === this.selectedId);
    if (!target || !this.agents) return;
    if (target.status !== "running") {
      this.setNotice(`${target.id} has already finished.`);
      return;
    }
    this.setNotice(`Aborting ${target.id}…`);
    const generation = this.generation;
    void this.agents.cancel([target.id]).then(
      () => {
        if (!this.disposed && generation === this.generation) this.setNotice(undefined);
      },
      (error: unknown) => {
        if (!this.disposed && generation === this.generation)
          this.setNotice(error instanceof Error ? error.message : String(error));
      },
    );
  }

  private setNotice(notice: string | undefined): void {
    if (this.disposed) return;
    this.notice = notice;
    this.requestRender();
  }

  private currentRows(): readonly SubagentSnapshot[] {
    return this.primaryTab === "subagents" && this.stateTab === "current"
      ? (this.agents?.list() ?? [])
      : [];
  }

  private reload(): void {
    if (this.disposed) return;
    const oldIndex = this.selectedId
      ? this.snapshots.findIndex((row) => row.id === this.selectedId)
      : this.selectedIndex;
    this.snapshots = this.currentRows();
    this.selectedId = reconcileSelection(
      this.snapshots.map((row) => row.id),
      this.selectedId,
      oldIndex,
    );
    this.selectedIndex = Math.max(
      0,
      this.snapshots.findIndex((row) => row.id === this.selectedId),
    );
    this.requestRender();
  }

  private requestRender(): void {
    if (!this.disposed) this.tui.requestRender();
  }
}

export function registerDashboardShell(
  pi: ExtensionAPI,
  resolveAgents: () => DashboardAgents | undefined,
  readRows: (tui: TUI) => number,
): void {
  const command = {
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
          new SubagentDashboard({ agents, tui, theme, close: () => done(), readRows }),
        {
          overlay: true,
          overlayOptions: {
            width: "100%",
            maxHeight: "100%",
            anchor: "center",
            margin: OVERLAY_MARGIN,
          },
        },
      );
    },
  } satisfies Parameters<ExtensionAPI["registerCommand"]>[1];
  const register = (name: "tasks" | "subagents" | "workspaces", focus: DashboardPrimaryTab) =>
    pi.registerCommand(name, {
      ...command,
      description: `Open the shared dashboard focused on ${name}`,
      handler: async (_args, ctx) => {
        if (ctx.mode !== "tui") {
          ctx.ui.notify(`/${name} requires interactive TUI mode.`, "error");
          return;
        }
        const agents = resolveAgents();
        await ctx.ui.custom<void>(
          (tui, theme, _keybindings, done) => {
            const view = new SubagentDashboard({
              agents,
              tui,
              theme,
              close: () => done(),
              readRows,
            });
            view.focus(focus);
            return view;
          },
          {
            overlay: true,
            overlayOptions: {
              width: "100%",
              maxHeight: "100%",
              anchor: "center",
              margin: OVERLAY_MARGIN,
            },
          },
        );
      },
    });
  register("tasks", "tasks");
  register("subagents", "subagents");
  register("workspaces", "workspaces");
}
