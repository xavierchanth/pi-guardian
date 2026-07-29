import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { ClientPreferencesReader } from "../config/register.ts";
import { detectThemeMode, type ThemeMode } from "./color.ts";
import type { QueryTerminalBackground } from "./query.ts";

const TUI_ACCESS_WIDGET = "pi-tai-ansi-theme-tui-access";

export function registerAnsiTheme(
  pi: ExtensionAPI,
  configService: ClientPreferencesReader,
  queryBackground: QueryTerminalBackground,
): void {
  let currentMode: ThemeMode | undefined;
  let timer: NodeJS.Timeout | undefined;
  let controller: AbortController | undefined;
  let activeUi: { setWidget(key: string, content: undefined): void } | undefined;
  let generation = 0;

  const stop = () => {
    generation++;
    if (timer) clearTimeout(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
    currentMode = undefined;
    activeUi?.setWidget(TUI_ACCESS_WIDGET, undefined);
    activeUi = undefined;
  };

  pi.on("session_start", async (_event, ctx) => {
    stop();
    if (ctx.mode !== "tui") return;

    let tui: TUI | undefined;
    activeUi = ctx.ui;
    // Widget factories receive the active TUI; an empty render keeps this access non-invasive.
    ctx.ui.setWidget(TUI_ACCESS_WIDGET, (activeTui: TUI) => {
      tui = activeTui;
      return { render: () => [], invalidate: () => undefined };
    });
    if (!tui) return;

    const sessionTui = tui;
    const activeGeneration = generation;
    const sessionController = new AbortController();
    controller = sessionController;
    const poll = async (): Promise<void> => {
      let background: string | undefined;
      try {
        background = await queryBackground(sessionTui, sessionController.signal);
      } catch {
        background = undefined;
      }
      if (activeGeneration !== generation || sessionController.signal.aborted) return;

      // Retrying after a timeout would accumulate records in affected pi-tui versions.
      if (!background) return;

      try {
        const mode = detectThemeMode(background);
        if (mode !== currentMode) {
          const config = configService.clientPreferences().ansiTheme;
          const theme = mode === "dark" ? config.darkTheme : config.lightTheme;
          const result = ctx.ui.setTheme(theme);
          if (result.success) currentMode = mode;
        }
      } catch {
        // Malformed response or failed application: retain the current theme and retry.
      }

      if (activeGeneration !== generation || sessionController.signal.aborted) return;
      const interval = configService.clientPreferences().ansiTheme.pollIntervalMs;
      timer = setTimeout(() => void poll(), interval);
    };

    await poll();
  });

  pi.on("session_shutdown", stop);
}
