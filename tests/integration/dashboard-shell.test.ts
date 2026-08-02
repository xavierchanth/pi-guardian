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

function harness(initial: SubagentSnapshot[] = []) {
  let rows = initial;
  let listener: ((snapshot: SubagentSnapshot) => void) | undefined;
  let renders = 0;
  let resolveCancel: (() => void) | undefined;
  const agents: DashboardAgents = {
    list: () => rows,
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    cancel: () =>
      new Promise<void>((resolve) => {
        resolveCancel = resolve;
      }),
  };
  const tui = {
    requestRender: () => {
      renders++;
    },
  } as unknown as TUI;
  const theme = { fg: (_tone: string, text: string) => text } as unknown as Theme;
  const view = new SubagentDashboard({ agents, tui, theme, close: () => {}, readRows: () => 10 });
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
  assert.match(archived, /Archived subagents are not available yet/);
  assert.doesNotMatch(archived, /three/);
});

test("unified action map enforces axes, active bindings, and input precedence", () => {
  assert.equal(resolveAction("l", "normal", "workspaces"), "primaryNext");
  assert.equal(resolveAction("h", "normal", "tasks"), "primaryPrevious");
  assert.equal(resolveAction("\t", "normal", "subagents"), "stateNext");
  assert.equal(resolveAction("[", "normal", "subagents"), undefined);
  assert.equal(resolveAction("]", "normal", "subagents"), undefined);
  assert.equal(resolveAction("/", "normal", "tasks"), "search");
  assert.equal(resolveAction("i", "normal", "subagents"), "inspectMode");
  assert.equal(resolveAction("p", "normal", "workspaces"), "marks");
  assert.equal(resolveAction("w", "normal", "tasks"), "workspace");
  assert.equal(resolveAction("x", "search", "subagents"), undefined);
  assert.equal(resolveAction("\x1b", "search", "subagents"), "close");
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
