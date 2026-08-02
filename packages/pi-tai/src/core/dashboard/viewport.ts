/** Terminal-independent dashboard navigation and bounded viewport primitives. */

export type DashboardPrimaryTab = "tasks" | "subagents" | "workspaces";
export type DashboardStateTab = "current" | "archived";

export const PRIMARY_TABS: readonly DashboardPrimaryTab[] = ["tasks", "subagents", "workspaces"];
export const STATE_TABS: readonly DashboardStateTab[] = ["current", "archived"];

export interface Viewport {
  readonly start: number;
  readonly end: number;
  readonly capacity: number;
}

export function normalizeCapacity(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** Preserve an identity across reorder/insert/delete, falling back near its old position. */
export function reconcileSelection(
  ids: readonly string[],
  selectedId: string | undefined,
  previousIndex = 0,
): string | undefined {
  if (ids.length === 0) return undefined;
  if (selectedId && ids.includes(selectedId)) return selectedId;
  const index = Math.min(Math.max(0, Math.trunc(previousIndex) || 0), ids.length - 1);
  return ids[index];
}

export function moveSelection(
  ids: readonly string[],
  selectedId: string | undefined,
  delta: number,
): string | undefined {
  if (ids.length === 0) return undefined;
  const current = selectedId ? ids.indexOf(selectedId) : -1;
  const index = current < 0 ? 0 : current;
  return ids[Math.min(ids.length - 1, Math.max(0, index + Math.trunc(delta)))];
}

/** Return the smallest bounded window containing the selected identity. */
export function ensureVisible(
  ids: readonly string[],
  selectedId: string | undefined,
  capacityValue: number,
  previousStart = 0,
): Viewport {
  const capacity = normalizeCapacity(capacityValue);
  if (capacity === 0 || ids.length === 0) return { start: 0, end: 0, capacity };
  const maxStart = Math.max(0, ids.length - capacity);
  let start = Math.min(maxStart, Math.max(0, Math.trunc(previousStart) || 0));
  const selected = selectedId ? ids.indexOf(selectedId) : -1;
  if (selected >= 0 && selected < start) start = selected;
  if (selected >= start + capacity) start = selected - capacity + 1;
  start = Math.min(maxStart, Math.max(0, start));
  return { start, end: Math.min(ids.length, start + capacity), capacity };
}

/** Fixed shell rows: border, primary tabs, state tabs, hint, border; notice costs one more. */
export function dashboardBodyCapacity(terminalRows: number, hasNotice = false): number {
  return (
    normalizeCapacity(terminalRows) -
    Math.min(normalizeCapacity(terminalRows), 5 + (hasNotice ? 1 : 0))
  );
}

export function cycleTab<T>(tabs: readonly T[], current: T, delta: number): T {
  const index = Math.max(0, tabs.indexOf(current));
  return tabs[(index + delta + tabs.length) % tabs.length] as T;
}
