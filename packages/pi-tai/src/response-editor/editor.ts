import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CustomEditor,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { buildEditorArguments, parseEditorCommand } from "./command.ts";
import { extractResponse, formatResponseDocument } from "./document.ts";

export interface ResponseEditorOptions {
  externalEditorCommand: string;
  getLastAssistantText(): string | undefined;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

export class ResponseEditor extends CustomEditor {
  private readonly hostTui: TUI;
  private readonly appKeybindings: KeybindingsManager;
  private readonly options: ResponseEditorOptions;
  private editingExternally = false;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    options: ResponseEditorOptions,
  ) {
    super(tui, theme, keybindings);
    this.hostTui = tui;
    this.appKeybindings = keybindings;
    this.options = options;
  }

  override handleInput(data: string): void {
    if (this.appKeybindings.matches(data, "app.editor.external")) {
      if (!this.editingExternally) void this.openExternalEditor();
      return;
    }
    super.handleInput(data);
  }

  private async openExternalEditor(): Promise<void> {
    const invocation = parseEditorCommand(this.options.externalEditorCommand);
    if (!invocation) {
      this.options.notify("External editor command is empty or has unmatched quotes.", "error");
      return;
    }

    const originalText = this.getExpandedText();
    const preview = this.options.getLastAssistantText();
    const contextual = preview !== undefined;
    const initialDocument = contextual
      ? formatResponseDocument(preview, originalText)
      : originalText;
    const tempFile = path.join(os.tmpdir(), `pi-tai-response-${Date.now()}.pi.md`);
    let tuiStopped = false;
    this.editingExternally = true;

    try {
      fs.writeFileSync(tempFile, initialDocument, "utf-8");
      this.hostTui.stop();
      tuiStopped = true;

      process.stdout.write(
        `Launching external editor: ${this.options.externalEditorCommand}\n` +
          "Pi will resume when the editor exits.\n",
      );
      const editorArguments = buildEditorArguments(invocation, tempFile, contextual);
      const status = await new Promise<number | null>((resolve) => {
        const child = spawn(invocation.executable, editorArguments, {
          stdio: "inherit",
          shell: process.platform === "win32",
        });
        child.on("error", () => resolve(null));
        child.on("close", (code) => resolve(code));
      });

      if (status !== 0) return;
      const editedDocument = fs.readFileSync(tempFile, "utf-8");
      if (!contextual) {
        this.setText(stripEditorFinalNewline(editedDocument));
        return;
      }

      const extraction = extractResponse(editedDocument);
      if (extraction.kind === "missing-opening-tag") {
        this.options.notify(
          "Response was not imported because the <response> opening tag was removed.",
          "warning",
        );
        return;
      }
      this.setText(extraction.text);
    } catch (error) {
      this.options.notify(
        `External editor failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    } finally {
      this.editingExternally = false;
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // Ignore cleanup errors.
      }
      if (tuiStopped) this.hostTui.start();
      this.hostTui.requestRender(true);
    }
  }
}

function stripEditorFinalNewline(content: string): string {
  return content.replace(/\r?\n$/, "");
}
