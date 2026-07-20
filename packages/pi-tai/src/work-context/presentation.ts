import type { WorkContextSnapshot } from "./domain.ts";

export interface WorkContextProgress {
  completed: number;
  total: number;
  active?: string;
  allComplete: boolean;
}

export function workContextProgress(
  snapshot: WorkContextSnapshot,
): WorkContextProgress {
  const completed = snapshot.plan.filter(
    (item) => item.status === "completed",
  ).length;
  return {
    completed,
    total: snapshot.plan.length,
    active: snapshot.plan.find((item) => item.status === "in_progress")
      ?.content,
    allComplete: snapshot.plan.length > 0 && completed === snapshot.plan.length,
  };
}

export function workContextStatusLines(
  snapshot: WorkContextSnapshot,
): [string, string] {
  const progress = workContextProgress(snapshot);
  const plan =
    progress.total === 0
      ? "Plan: No active steps"
      : progress.active
        ? `Plan: ${progress.completed}/${progress.total} | Now: ${progress.active}`
        : progress.allComplete
          ? `Plan: ${progress.completed}/${progress.total} | Complete`
          : `Plan: ${progress.completed}/${progress.total} | Now: —`;
  return [`Goal: ${snapshot.goal}`, plan];
}

export function collapsedWorkContextText(
  snapshot: WorkContextSnapshot,
): string {
  const progress = workContextProgress(snapshot);
  if (progress.total === 0) return "✓ Goal updated · No active steps";
  if (progress.active) {
    return `✓ Plan ${progress.completed}/${progress.total} · Now: ${progress.active}`;
  }
  if (progress.allComplete) {
    return `✓ Plan ${progress.completed}/${progress.total} · Complete`;
  }
  return `✓ Plan ${progress.completed}/${progress.total} · No active step`;
}

export function fullWorkContextText(snapshot: WorkContextSnapshot): string {
  const progress = workContextProgress(snapshot);
  const lines = [`Goal: ${snapshot.goal}`];
  if (snapshot.explanation) lines.push(`Explanation: ${snapshot.explanation}`);
  lines.push(
    progress.total === 0
      ? "Plan: No active steps"
      : `Plan: ${progress.completed}/${progress.total}`,
  );

  for (const item of snapshot.plan) {
    const marker =
      item.status === "completed"
        ? "x"
        : item.status === "in_progress"
          ? ">"
          : " ";
    const priority = item.priority ? ` [${item.priority}]` : "";
    lines.push(`[${marker}] ${item.content}${priority}`);
  }
  return lines.join("\n");
}
