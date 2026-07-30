import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { DiagnosticSink } from "./diagnostics.ts";

export class HeadlessInteractionError extends Error {
  constructor(kind: string) {
    super(`Interactive extension UI is unavailable in hosted mode: ${kind}`);
    this.name = "HeadlessInteractionError";
  }
}

export function createHeadlessUiContext(diagnostics: DiagnosticSink): ExtensionUIContext {
  const unsupported = async (kind: string): Promise<never> => {
    throw new HeadlessInteractionError(kind);
  };
  const context: Record<PropertyKey, unknown> = {
    select: () => unsupported("select"),
    confirm: () => unsupported("confirm"),
    input: () => unsupported("input"),
    custom: () => unsupported("custom"),
    editor: () => unsupported("editor"),
    notify: (message: string, type: "info" | "warning" | "error" = "info") =>
      diagnostics({
        timestamp: new Date().toISOString(),
        level: type === "warning" ? "warn" : type,
        event: "extension_notification",
        data: { characters: message.length },
      }),
    onTerminalInput: () => () => {},
    getEditorText: () => "",
    getEditorComponent: () => undefined,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "UI not available" }),
    getToolsExpanded: () => false,
    theme: undefined,
  };
  return new Proxy(context, {
    get(target, property) {
      return property in target ? target[property] : () => {};
    },
  }) as unknown as ExtensionUIContext;
}
