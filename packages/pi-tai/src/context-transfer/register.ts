import { randomBytes } from "node:crypto";
import { copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createContextTransferArtifact,
  encodeId,
  frameImportedContext,
  validateId,
} from "./domain.ts";
import { CONTEXT_IMPORT_TYPE, registerContextImportRenderer } from "./render.ts";
import { summarizeContextWithActiveModel, type ContextSummarizer } from "./summarize.ts";
import { createFileContextTransferStore, type ContextTransferStore } from "./storage.ts";

export interface ContextTransferDependencies {
  store: ContextTransferStore;
  summarize: ContextSummarizer;
  createId(): string;
  copy(text: string): Promise<void>;
  now(): Date;
}

export function registerContextTransfer(
  pi: ExtensionAPI,
  agentDir: string,
  dependencies: Partial<ContextTransferDependencies> = {},
): void {
  const store = dependencies.store ?? createFileContextTransferStore(agentDir);
  const summarize = dependencies.summarize ?? summarizeContextWithActiveModel;
  const createId = dependencies.createId ?? (() => encodeId(randomBytes(5)));
  const copy = dependencies.copy ?? copyToClipboard;
  const now = dependencies.now ?? (() => new Date());

  registerContextImportRenderer(pi);

  pi.registerCommand("context-export", {
    description: "Summarize this branch for transfer to another session",
    handler: async (args, ctx) => {
      ctx.ui.setStatus("context-transfer", "Exporting context…");
      try {
        const summary = await summarize({ notes: args, ctx, pi });
        if (summary === undefined) {
          ctx.ui.notify("There is no session context to export.", "info");
          return;
        }
        if (!ctx.model) throw new Error("No active model is selected.");

        let id: string | undefined;
        for (let attempt = 0; attempt < 5; attempt++) {
          const candidate = validateId(createId());
          if (!(await store.exists(candidate))) {
            id = candidate;
            break;
          }
        }
        if (!id) throw new Error("Could not allocate an ID after five collisions.");

        const artifact = createContextTransferArtifact({
          id,
          summary,
          notes: args.trim() || undefined,
          createdAt: now(),
          source: {
            cwd: ctx.cwd,
            sessionId: ctx.sessionManager.getSessionId(),
            model: { provider: ctx.model.provider, id: ctx.model.id },
            piTaiVersion: "0.1.0",
          },
        });
        await store.save(artifact);

        const command = `/context-import ${id}`;
        ctx.ui.notify(command, "info");
        try {
          await copy(command);
        } catch {
          ctx.ui.notify("Context exported, but copying to the clipboard failed.", "warning");
        }
        try {
          await store.prune(now());
        } catch {
          ctx.ui.notify("Context exported, but retention cleanup failed.", "warning");
        }
      } catch (error) {
        ctx.ui.notify(`Context export failed: ${describe(error)}`, "error");
      } finally {
        ctx.ui.setStatus("context-transfer", undefined);
      }
    },
  });

  pi.registerCommand("context-import", {
    description: "Import durable context from a context export ID",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /context-import <ID>", "error");
        return;
      }
      try {
        await ctx.waitForIdle();
        const id = validateId(args);
        const artifact = await store.load(id);
        pi.sendMessage(
          {
            customType: CONTEXT_IMPORT_TYPE,
            content: frameImportedContext(artifact),
            display: true,
            details: { id, summary: artifact.summary },
          },
          { triggerTurn: true },
        );
      } catch (error) {
        ctx.ui.notify(`Context import failed: ${describe(error)}`, "error");
      }
    },
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
