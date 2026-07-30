export const PLAN_STATUSES = ["pending", "in_progress", "completed"] as const;
export const PLAN_PRIORITIES = ["low", "medium", "high"] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];
export type PlanPriority = (typeof PLAN_PRIORITIES)[number];

export interface PlanItem {
  content: string;
  status: PlanStatus;
  priority?: PlanPriority;
}

export interface WorkContextSnapshot {
  goal: string;
  explanation?: string;
  plan: readonly PlanItem[];
}

export interface WorkContextUpdate {
  goal: string;
  explanation?: string;
  plan: PlanItem[];
}

export interface WorkContextDetails extends WorkContextSnapshot {
  version: 1;
}

export function validateWorkContextUpdate(
  input: WorkContextUpdate,
  previous?: WorkContextSnapshot,
): WorkContextSnapshot {
  const goal = normalizeText(input.goal);
  if (!goal) throw new Error("Work-context goal must not be empty.");

  const explanation = normalizeText(input.explanation ?? "") || undefined;
  const plan = input.plan.map((item, index) => normalizeItem(item, index));
  const inProgress = plan.filter((item) => item.status === "in_progress");
  if (inProgress.length > 1) {
    throw new Error("Work context may contain at most one in_progress item.");
  }

  const identities = new Set<string>();
  for (const item of plan) {
    const identity = planItemIdentity(item.content);
    if (identities.has(identity)) {
      throw new Error(`Duplicate plan item: ${item.content}`);
    }
    identities.add(identity);

    if (item.status !== "completed") continue;
    const prior = previous?.plan.find(
      (candidate) => planItemIdentity(candidate.content) === identity,
    );
    if (!prior || (prior.status !== "in_progress" && prior.status !== "completed")) {
      throw new Error(`Plan item must be in_progress before completed: ${item.content}`);
    }
  }

  return freezeSnapshot({ goal, explanation, plan });
}

export function parseWorkContextDetails(value: unknown): WorkContextSnapshot | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (typeof value.goal !== "string" || !Array.isArray(value.plan)) return undefined;
  try {
    const snapshot = validatePersistedSnapshot({
      goal: value.goal,
      explanation: typeof value.explanation === "string" ? value.explanation : undefined,
      plan: value.plan as PlanItem[],
    });
    return snapshot;
  } catch {
    return undefined;
  }
}

export function workContextDetails(snapshot: WorkContextSnapshot): WorkContextDetails {
  return Object.freeze({
    version: 1 as const,
    goal: snapshot.goal,
    ...(snapshot.explanation ? { explanation: snapshot.explanation } : {}),
    plan: snapshot.plan.map((item) => Object.freeze({ ...item })),
  });
}

export function formatWorkContext(snapshot: WorkContextSnapshot): string {
  const lines = [`Goal: ${snapshot.goal}`];
  if (snapshot.explanation) lines.push(`Explanation: ${snapshot.explanation}`);
  lines.push("Plan:");
  if (snapshot.plan.length === 0) {
    lines.push("- (no plan items)");
  } else {
    for (const item of snapshot.plan) {
      const marker = item.status === "completed" ? "x" : item.status === "in_progress" ? ">" : " ";
      const priority = item.priority ? `; priority: ${item.priority}` : "";
      lines.push(`- [${marker}] ${item.content} (${item.status}${priority})`);
    }
  }
  return lines.join("\n");
}

export function planItemIdentity(content: string): string {
  return normalizeText(content).toLocaleLowerCase();
}

function validatePersistedSnapshot(input: WorkContextUpdate): WorkContextSnapshot {
  const goal = normalizeText(input.goal);
  if (!goal) throw new Error("empty goal");
  const explanation = normalizeText(input.explanation ?? "") || undefined;
  const plan = input.plan.map((item, index) => normalizeItem(item, index));
  if (plan.filter((item) => item.status === "in_progress").length > 1) {
    throw new Error("too many active items");
  }
  if (new Set(plan.map((item) => planItemIdentity(item.content))).size !== plan.length) {
    throw new Error("duplicate items");
  }
  return freezeSnapshot({ goal, explanation, plan });
}

function normalizeItem(item: PlanItem, index: number): PlanItem {
  if (!isRecord(item)) throw new Error(`Plan item ${index + 1} must be an object.`);
  const content = normalizeText(typeof item.content === "string" ? item.content : "");
  if (!content) throw new Error(`Plan item ${index + 1} content must not be empty.`);
  if (!PLAN_STATUSES.includes(item.status as PlanStatus)) {
    throw new Error(`Plan item ${index + 1} has an invalid status.`);
  }
  if (item.priority !== undefined && !PLAN_PRIORITIES.includes(item.priority as PlanPriority)) {
    throw new Error(`Plan item ${index + 1} has an invalid priority.`);
  }
  return Object.freeze({
    content,
    status: item.status as PlanStatus,
    ...(item.priority ? { priority: item.priority as PlanPriority } : {}),
  });
}

function freezeSnapshot(snapshot: {
  goal: string;
  explanation?: string;
  plan: readonly PlanItem[];
}): WorkContextSnapshot {
  return Object.freeze({
    goal: snapshot.goal,
    ...(snapshot.explanation ? { explanation: snapshot.explanation } : {}),
    plan: Object.freeze(snapshot.plan.map((item) => Object.freeze({ ...item }))),
  });
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
