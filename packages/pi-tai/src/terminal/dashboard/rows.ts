import type { TUI } from "@earendil-works/pi-tui";

/** Used only when an older/nonstandard TUI does not expose terminal dimensions. */
export const FALLBACK_TERMINAL_ROWS = 24;

/** Read the live terminal budget. Kept in terminal code so core layout stays host-independent. */
export function terminalRows(tui: TUI): number {
  const rows = (tui as TUI & { terminal?: { rows?: unknown } }).terminal?.rows;
  return typeof rows === "number" && Number.isFinite(rows) && rows > 0
    ? Math.trunc(rows)
    : FALLBACK_TERMINAL_ROWS;
}
