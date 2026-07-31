import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentSnapshot, SubagentStatus } from "./domain.ts";
import type { SubagentManager } from "./manager.ts";

export interface SubagentActivity {
  readonly displayId: string;
  readonly activity: string;
  readonly lastActivityAt: string;
}

export interface SubagentActivitySummary {
  readonly latest?: SubagentActivity;
  readonly totals: Readonly<Record<SubagentStatus, number>>;
}

/** The footer only receives this projection, never child snapshots or transcripts. */
export interface SubagentActivityProvider {
  read(): SubagentActivitySummary;
  subscribe(listener: () => void): () => void;
}

const providers = new WeakMap<ExtensionAPI, ActivityProjection>();

export function subagentActivityProvider(pi: ExtensionAPI): SubagentActivityProvider {
  let provider = providers.get(pi);
  if (!provider) {
    provider = new ActivityProjection();
    providers.set(pi, provider);
  }
  return provider;
}

export function connectSubagentActivity(pi: ExtensionAPI, manager: SubagentManager): void {
  const provider = subagentActivityProvider(pi) as ActivityProjection;
  provider.connect(manager);
}

const MAX_ACTIVITY = 120;

export function projectActivity(snapshot: SubagentSnapshot): SubagentActivity {
  const activeTool = [...snapshot.liveTools].reverse().find((tool) => tool.state === "running");
  const raw = activeTool
    ? `${activeTool.name}${activeTool.preview ? `: ${activeTool.preview}` : ""}`
    : snapshot.latestText ||
      (snapshot.status === "running"
        ? "running"
        : snapshot.status === "done"
          ? "completed"
          : "failed") ||
      snapshot.title;
  const activity = sanitize(raw);
  return {
    displayId: snapshot.id,
    activity: bound(activity || sanitize(snapshot.title) || "Subagent"),
    lastActivityAt: snapshot.lastActivityAt ?? snapshot.createdAt,
  };
}

function sanitize(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function bound(text: string): string {
  const codePoints = [...text];
  return codePoints.length <= MAX_ACTIVITY
    ? text
    : `${codePoints.slice(0, MAX_ACTIVITY - 1).join("")}…`;
}

export function summarizeSubagentActivity(
  snapshots: readonly SubagentSnapshot[],
): SubagentActivitySummary {
  const totals = { running: 0, done: 0, error: 0 };
  for (const snapshot of snapshots) totals[snapshot.status]++;
  const latest = snapshots
    .filter((snapshot) => snapshot.lastActivityAt)
    .sort((a, b) => b.lastActivityAt!.localeCompare(a.lastActivityAt!))[0];
  return { ...(latest ? { latest: projectActivity(latest) } : {}), totals };
}

class ActivityProjection implements SubagentActivityProvider {
  private manager?: SubagentManager;
  private unsubscribe?: () => void;
  private readonly listeners = new Set<() => void>();

  connect(manager: SubagentManager): void {
    if (this.manager === manager) return;
    this.unsubscribe?.();
    this.manager = manager;
    this.unsubscribe = manager.subscribe(() => {
      for (const listener of this.listeners) listener();
    });
    for (const listener of this.listeners) listener();
  }

  read(): SubagentActivitySummary {
    return summarizeSubagentActivity(this.manager?.list() ?? []);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
