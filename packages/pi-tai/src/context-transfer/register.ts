import { randomBytes } from "node:crypto";
import { copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createContextTransferArtifact, frameImportedContext } from "./domain.ts";
import type { ContextSummarizer } from "./summarize.ts";
import { summarizeContextWithActiveModel } from "./summarize.ts";
import { createFileContextTransferStore, type ContextTransferStore } from "./storage.ts";

export interface ContextTransferDependencies { store: ContextTransferStore; summarize: ContextSummarizer; createId(): string }

export function registerContextTransfer(pi: ExtensionAPI, agentDir: string, dependencies?: Partial<ContextTransferDependencies>): void {
  const store = dependencies?.store ?? createFileContextTransferStore(agentDir);
  const summarize = dependencies?.summarize ?? summarizeContextWithActiveModel;
  const createId = dependencies?.createId ?? (() => randomBytes(6).toString("hex"));
  pi.registerCommand("context-export", {
    description: "Summarize this branch for transfer to another session",
    handler: async (args, ctx) => {
      try {
        // completeSimple receives a detached branch snapshot; no message is appended to the live session.
        const summary = await summarize({ branch: ctx.sessionManager.getBranch(), notes: args, ctx });
        const artifact = createContextTransferArtifact(createId(), summary);
        await store.save(artifact);
        const command = `/context-import ${artifact.id}`;
        const copied = await copyToClipboard(command).then(() => true, () => false);
        ctx.ui.notify(`${command}${copied ? " (copied to clipboard)" : ""}`, "info");
      } catch (error) {
        ctx.ui.notify(`Context export failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
  pi.registerCommand("context-import", {
    description: "Import durable context from a context-transfer ID",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) { ctx.ui.notify("Usage: /context-import <ID>", "error"); return; }
      try {
        const artifact = await store.load(id);
        pi.sendMessage({ customType: "context-transfer", content: frameImportedContext(artifact), display: true }, { triggerTurn: true });
      } catch (error) {
        ctx.ui.notify(`Context import failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
