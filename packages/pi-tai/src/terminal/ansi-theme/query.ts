import type { TUI } from "@earendil-works/pi-tui";

export type QueryTerminalBackground = (
  tui: Pick<TUI, "queryTerminalBackgroundColor">,
  signal?: AbortSignal,
) => Promise<string | undefined>;

const QUERY_TIMEOUT_MS = 500;

/** Query through the active TUI, which is the sole owner of terminal input. */
export const queryTerminalBackground: QueryTerminalBackground = async (tui, signal) => {
  if (signal?.aborted) return undefined;

  let abort: (() => void) | undefined;
  const aborted = signal
    ? new Promise<undefined>((resolve) => {
        abort = () => resolve(undefined);
        signal.addEventListener("abort", abort, { once: true });
      })
    : undefined;

  try {
    const query = tui.queryTerminalBackgroundColor({ timeoutMs: QUERY_TIMEOUT_MS });
    const color = aborted ? await Promise.race([query, aborted]) : await query;
    if (!color || signal?.aborted) return undefined;

    const hex = (value: number) =>
      Math.max(0, Math.min(255, Math.round(value)))
        .toString(16)
        .padStart(2, "0");
    return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
  }
};
