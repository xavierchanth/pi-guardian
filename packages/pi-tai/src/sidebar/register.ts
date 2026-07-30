import { buildSessionContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { askBtw } from "./ask.ts";
import { BTW_ENTRY_TYPE, BTW_MAX_IN_FLIGHT, BTW_TIMEOUT_MS, type BtwEntry } from "./domain.ts";
import { registerBtwRenderer } from "./render.ts";

export function registerBtw(pi: ExtensionAPI): void {
  let inFlight = 0;
  const controllers = new Set<AbortController>();
  registerBtwRenderer(pi);

  pi.on("session_shutdown", () => {
    for (const controller of controllers) controller.abort(new Error("Session shutting down"));
  });

  pi.registerCommand("btw", {
    description: "Ask a one-off question using the current session context",
    handler: async (args, ctx) => {
      const question = args.trim() || (ctx.hasUI
        ? await ctx.ui.input("by the way", "Ask a one-off question…")
        : undefined);
      if (!question?.trim()) return;
      if (inFlight >= BTW_MAX_IN_FLIGHT) {
        ctx.ui.notify("Too many by-the-way questions are already running.", "warning");
        return;
      }
      // Reservation and snapshot are synchronous: concurrent commands cannot exceed the cap or
      // observe entries appended after invocation.
      inFlight++;
      const entries = [...ctx.sessionManager.getEntries()];
      const leaf = ctx.sessionManager.getLeafId();
      const messages = buildSessionContext(entries, leaf).messages;
      const model = ctx.model;
      const effort = pi.getThinkingLevel();
      const modelName = model ? `${model.provider}/${model.id}` : "unresolved";
      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(new Error("Timed out")), BTW_TIMEOUT_MS);
      let data: BtwEntry;
      try {
        if (!model) throw new Error("No current session model is selected.");
        // Resolve the exact selected model and its auth; never choose a substitute.
        const resolved = ctx.modelRegistry.find(model.provider, model.id);
        if (!resolved) throw new Error(`Current model not found: ${modelName}`);
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(resolved);
        if (!auth.ok) throw new Error(auth.error);
        const result = await askBtw({ model: resolved, auth, messages, question: question.trim(), effort, signal: controller.signal });
        data = { state: "success", question: question.trim(), answer: result.answer, model: modelName, timestamp: new Date().toISOString(), truncation: { input: result.inputTruncated, output: result.outputTruncated } };
      } catch (error) {
        const message = controller.signal.aborted
          ? (controller.signal.reason instanceof Error ? controller.signal.reason.message : "Cancelled")
          : error instanceof Error ? error.message : String(error);
        data = { state: "error", question: question.trim(), error: message, model: modelName, timestamp: new Date().toISOString(), truncation: { input: false, output: false } };
      } finally {
        clearTimeout(timer);
        controllers.delete(controller);
        inFlight--;
      }
      // Every failure after question validation is durable and custom entries never enter context.
      pi.appendEntry(BTW_ENTRY_TYPE, data);
    },
  });
}
