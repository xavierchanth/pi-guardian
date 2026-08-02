import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
  emptySnapshot,
  type SubagentSnapshot,
} from "../../packages/pi-tai/src/core/subagents/domain.ts";
import {
  SubagentDashboard,
  type DashboardAgents,
  OVERLAY_MARGIN,
  resolveAction,
  registerDashboardShell,
} from "../../packages/pi-tai/src/terminal/dashboard/view.ts";

function snapshot(id: string): SubagentSnapshot {
  return emptySnapshot({
    id,
    backend: "pi",
    title: id,
    cwd: "/tmp",
    createdAt: new Date(0).toISOString(),
  });
}

function harness(initial: SubagentSnapshot[] = [], terminalRows = 10) {
  let rows = initial;
  let listener: ((snapshot: SubagentSnapshot) => void) | undefined;
  let renders = 0;
  let resolveCancel: (() => void) | undefined;
  let cancelCalls = 0;
  const agents: DashboardAgents = {
    list: () => rows,
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    cancel: () => {
      cancelCalls++;
      return new Promise<void>((resolve) => {
        resolveCancel = resolve;
      });
    },
  };
  const tui = {
    requestRender: () => {
      renders++;
    },
  } as unknown as TUI;
  const theme = { fg: (_tone: string, text: string) => text } as unknown as Theme;
  const view = new SubagentDashboard({
    agents,
    tui,
    theme,
    close: () => {},
    readRows: () => terminalRows,
  });
  return {
    view,
    lines: () => view.render(80),
    renders: () => renders,
    mutate(next: SubagentSnapshot[]) {
      rows = next;
      if (next[0]) listener?.(next[0]);
    },
    resolveCancel: () => resolveCancel?.(),
    subscribed: () => Boolean(listener),
    cancelCalls: () => cancelCalls,
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("subagents are synchronous and unpaged while rendering within overlay margins", () => {
  const all = Array.from({ length: 80 }, (_, index) => snapshot(`agent-${index}`));
  const h = harness(all);
  assert.ok(h.lines().some((line) => line.includes("agent-0")));
  assert.equal(
    h.lines().some((line) => line.includes("Loading")),
    false,
  );
  assert.ok(h.lines().length <= 10 - OVERLAY_MARGIN * 2);
  for (let index = 0; index < 75; index++) h.view.handleInput("j");
  assert.ok(
    h.lines().some((line) => line.includes("agent-75")),
    "rows beyond the former 60-row cap remain reachable",
  );

  h.mutate([snapshot("three")]);
  assert.ok(h.lines().some((line) => line.includes("three")));
  h.view.handleInput("\t");
  const archived = h.lines().join("\n");
  assert.match(archived, /Archived subagent data is not available/);
  assert.doesNotMatch(archived, /three/);
});

test("§4.8 dispatch table is exhaustive, contextual, and mode-first", () => {
  const expected = {
    tasks: {
      a: "actionMenu",
      x: "cancel",
      p: "taskImportRevision",
      e: "archiveRestore",
      v: "mark",
      V: "markAll",
      s: "jumpSubagent",
      w: "jumpWorkspace",
      i: "taskEdit",
      "\r": "taskEdit",
    },
    subagents: {
      a: "actionMenu",
      x: "cancel",
      p: undefined,
      e: "archiveRestore",
      v: "mark",
      V: "markAll",
      s: undefined,
      w: "jumpWorkspace",
      i: "subagentDetail",
      "\r": "subagentDetail",
    },
    workspaces: {
      a: "actionMenu",
      x: "cancel",
      p: undefined,
      e: undefined,
      v: "mark",
      V: "markAll",
      s: "jumpSubagent",
      w: undefined,
      i: "workspaceCustodyDetail",
      "\r": "workspaceCustodyDetail",
    },
  } as const;
  for (const [tab, bindings] of Object.entries(expected))
    for (const [key, action] of Object.entries(bindings))
      assert.equal(
        resolveAction(key, "normal", tab as keyof typeof expected),
        action,
        `${tab}:${key}`,
      );
  for (const tab of ["tasks", "subagents", "workspaces"] as const) {
    assert.equal(resolveAction("/", "normal", tab), "search");
    assert.equal(resolveAction("[", "normal", tab), undefined);
    assert.equal(resolveAction("]", "normal", tab), undefined);
    assert.equal(resolveAction("x", "search", tab), undefined);
    assert.equal(resolveAction("\x1b", "search", tab), "close");
    assert.equal(resolveAction("h", "detail", tab), undefined);
    assert.equal(resolveAction("l", "detail", tab), undefined);
    assert.equal(resolveAction("\x1b[6~", "normal", tab), "pageDown");
  }
});

test("row budget holds for list, notice, and detail at every terminal height", () => {
  for (let rows = 0; rows <= 60; rows++) {
    const limit = Math.max(0, rows - OVERLAY_MARGIN * 2);
    const list = harness([snapshot("one"), snapshot("two")], rows);
    assert.ok(list.lines().length <= limit, `list at ${rows}`);
    list.view.handleInput("a");
    assert.ok(list.lines().length <= limit, `notice at ${rows}`);
    const detail = harness([snapshot("one")], rows);
    detail.view.handleInput("\r");
    assert.ok(detail.lines().length <= limit, `detail at ${rows}`);
  }
});

test("action menu never invokes subagent cancellation and unavailable actions are named", () => {
  const h = harness([{ ...snapshot("run"), status: "running" as const }]);
  h.view.handleInput("a");
  assert.equal(h.cancelCalls(), 0);
  assert.match(h.lines().join("\n"), /Action menu is not available on Subagents yet/);
  h.view.handleInput("x");
  assert.equal(h.cancelCalls(), 1);
});

test("primary tab navigation never wraps at either boundary", () => {
  const left = harness([snapshot("one")]);
  left.view.focus("tasks");
  left.view.handleInput("h");
  assert.match(left.lines().join("\n"), /\[Tasks\]/);
  const right = harness([snapshot("one")]);
  right.view.focus("workspaces");
  right.view.handleInput("l");
  assert.match(right.lines().join("\n"), /\[Workspaces\]/);
});

test("registers exactly the three public dashboard commands", () => {
  const commands: string[] = [];
  const pi = { registerCommand: (name: string) => commands.push(name) };
  registerDashboardShell(
    pi as never,
    () => undefined,
    () => 24,
  );
  assert.deepEqual(commands, ["tasks", "subagents", "workspaces"]);
});

test("disposal removes subscriptions and suppresses hydration and cancel completions", async () => {
  const running = { ...snapshot("run"), status: "running" as const };
  const h = harness([running]);
  await settle();
  h.view.handleInput("x");
  const before = h.renders();
  h.view.dispose();
  assert.equal(h.subscribed(), false);
  h.resolveCancel();
  h.mutate([snapshot("late")]);
  await settle();
  assert.equal(h.renders(), before);
});
