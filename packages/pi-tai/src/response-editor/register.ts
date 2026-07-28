import {
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { findLastAssistantText } from "./document.ts";
import { ResponseEditor } from "./editor.ts";

export function registerResponseEditor(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    const settings = SettingsManager.create(ctx.cwd, undefined, {
      projectTrusted: ctx.isProjectTrusted(),
    });
    const externalEditorCommand = settings.getExternalEditorCommand();
    if (!externalEditorCommand) return;

    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) =>
        new ResponseEditor(tui, theme, keybindings, {
          externalEditorCommand,
          getLastAssistantText: () => findLastAssistantText(ctx.sessionManager.getBranch()),
          notify: (message, level) => ctx.ui.notify(message, level),
        }),
    );
  });
}
