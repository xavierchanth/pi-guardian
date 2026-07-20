import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  validateWorkContextUpdate,
  workContextDetails,
} from "../../packages/pi-tai/src/work-context/domain.ts";
import { registerWorkContext } from "../../packages/pi-tai/src/work-context/register.ts";

type Handler = (event: unknown, ctx: any) => unknown;

test("registered update_plan reconstructs state on session and tree changes", async () => {
  const handlers = new Map<string, Handler[]>();
  let tool: any;
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(definition: any) {
      tool = definition;
    },
  } as unknown as ExtensionAPI;

  registerWorkContext(pi);
  assert.equal(tool.name, "update_plan");
  assert.equal(handlers.has("message_end"), false);
  assert.equal(handlers.has("before_agent_start"), false);

  const active = workContextDetails(validateWorkContextUpdate({
    goal: "Ship",
    plan: [{ content: "Implement", status: "in_progress" }],
  }));
  let branch: unknown[] = [toolResult(active)];
  const ctx = { sessionManager: { getBranch: () => branch } };
  await emit(handlers, "session_start", ctx);

  const result = await tool.execute("call", {
    goal: "Ship",
    plan: [{ content: "Implement", status: "completed" }],
  });
  assert.equal(result.details.plan[0].status, "completed");
  assert.match(result.content[0].text, /Goal: Ship/);

  const pending = workContextDetails(validateWorkContextUpdate({
    goal: "Alternate",
    plan: [{ content: "Other", status: "pending" }],
  }));
  branch = [toolResult(pending)];
  await emit(handlers, "session_tree", ctx);
  await assert.rejects(() => tool.execute("call", {
    goal: "Alternate",
    plan: [{ content: "Other", status: "completed" }],
  }), /must be in_progress/);
});

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
