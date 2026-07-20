import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiTaiConfigService } from "../config/register.ts";
import { detectThemeMode, type ThemeMode } from "./color.ts";
import type { QueryTerminalBackground } from "./query.ts";

export function registerAnsiTheme(
  pi: ExtensionAPI,
  configService: PiTaiConfigService,
  queryBackground: QueryTerminalBackground,
): void {
  let currentMode: ThemeMode | undefined;
  let timer: NodeJS.Timeout | undefined;
  let controller: AbortController | undefined;
  let generation = 0;

  const stop = () => {
    generation++;
    if (timer) clearTimeout(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
    currentMode = undefined;
  };

  pi.on("session_start", async (_event, ctx) => {
    stop();
    if (ctx.mode !== "tui") return;

    const activeGeneration = generation;
    controller = new AbortController();
    const poll = async (): Promise<void> => {
      let background: string | undefined;
      try {
        background = await queryBackground(controller?.signal);
      } catch {
        background = undefined;
      }
      if (activeGeneration !== generation || controller?.signal.aborted) return;

      if (background) {
        try {
          const mode = detectThemeMode(background);
          if (mode !== currentMode) {
            currentMode = mode;
            const config = configService.current().ansiTheme;
            const theme = mode === "dark" ? config.darkTheme : config.lightTheme;
            ctx.ui.setTheme(theme);
          }
        } catch {
          // Unsupported or malformed terminal response: retain the current theme.
        }
      }

      const interval = configService.current().ansiTheme.pollIntervalMs;
      timer = setTimeout(() => void poll(), interval);
    };

    await poll();
  });

  pi.on("session_shutdown", stop);
}
