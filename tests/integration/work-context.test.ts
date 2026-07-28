import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  validateWorkContextUpdate,
  workContextDetails,
} from "../../packages/pi-tai/src/work-context/domain.ts";
import { registerWorkContext } from "../../packages/pi-tai/src/work-context/register.ts";

type Handler = (event: unknown, ctx: any) => unknown;

test("registered update_plan reconstructs state and supports on-demand TUI presentation", async () => {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  let customViews = 0;
  let tool: any;
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(definition: any) {
      tool = definition;
    },
    registerCommand(name: string, definition: any) {
      commands.set(name, definition);
    },
  } as unknown as ExtensionAPI;

  registerWorkContext(pi);
  assert.equal(tool.name, "update_plan");
  assert.match(tool.description, /multiple meaningful steps/);
  assert.ok(tool.promptGuidelines.some((line: string) => line.includes("materially changing scope")));
  assert.equal(commands.has("plan-status"), true);
  assert.equal(handlers.has("message_end"), false);
  assert.equal(handlers.has("before_agent_start"), false);

  const active = workContextDetails(validateWorkContextUpdate({
    goal: "Ship a terminal refresh with a deliberately long goal",
    plan: [{ content: "Implement the visual", status: "in_progress" }],
  }));
  let branch: unknown[] = [toolResult(active)];
  const ctx = {
    mode: "tui",
    sessionManager: { getBranch: () => branch },
    ui: {
      notify() {},
      async custom(factory: any) {
        customViews++;
        factory({}, fakeTheme(), {}, () => {});
      },
    },
  };
  await emit(handlers, "session_start", ctx);

  const result = await tool.execute(
    "call",
    {
      goal: "Ship",
      plan: [{ content: "Implement the visual", status: "completed" }],
    },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(result.details.plan[0].status, "completed");
  assert.match(result.content[0].text, /Goal: Ship/);
  const collapsed = tool
    .renderResult(result, { expanded: false }, fakeTheme(), {})
    .render(100)
    .join("\n");
  const expanded = tool
    .renderResult(result, { expanded: true }, fakeTheme(), {})
    .render(100)
    .join("\n");
  assert.match(collapsed, /✓ Plan 1\/1 · Complete/);
  assert.match(expanded, /\[x] Implement the visual/);

  await commands.get("plan-status").handler("", ctx);
  assert.equal(customViews, 1);

  const pending = workContextDetails(validateWorkContextUpdate({
    goal: "Alternate",
    plan: [{ content: "Other", status: "pending" }],
  }));
  branch = [toolResult(pending)];
  await emit(handlers, "session_tree", ctx);
  await assert.rejects(() => tool.execute(
    "call",
    {
      goal: "Alternate",
      plan: [{ content: "Other", status: "completed" }],
    },
    undefined,
    undefined,
    ctx,
  ), /must be in_progress/);

});

test("plan-status reports when no work context exists", async () => {
  const commands = new Map<string, any>();
  const notifications: string[] = [];
  const pi = {
    on() {},
    registerTool() {},
    registerCommand(name: string, definition: any) {
      commands.set(name, definition);
    },
  } as unknown as ExtensionAPI;
  registerWorkContext(pi);
  await commands.get("plan-status").handler("", {
    mode: "tui",
    ui: { notify(message: string) { notifications.push(message); } },
  });
  assert.deepEqual(notifications, ["No active work context."]);
});

function fakeTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

function toolResult(details: unknown) {
  return {
    type: "message",
    message: { role: "toolResult", toolName: "update_plan", details },
  };
}

async function emit(
  handlers: Map<string, Handler[]>,
  event: string,
  ctx: any,
): Promise<void> {
  for (const handler of handlers.get(event) ?? []) {
    await handler({}, ctx);
  }
}
