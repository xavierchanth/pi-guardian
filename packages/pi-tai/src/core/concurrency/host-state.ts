import { randomUUID } from "node:crypto";
import { HostConcurrencyRepository } from "./host-repository.ts";
import type { ConcurrencyProjectionV1 } from "./productization.ts";

export class HostConcurrencyState {
  private readonly repository: HostConcurrencyRepository;
  private readonly rootSessionId: string;
  private readonly runtimeGeneration: number;
  private queue = Promise.resolve();
  constructor(options: {
    repository: HostConcurrencyRepository;
    rootSessionId: string;
    runtimeGeneration: number;
  }) {
    this.repository = options.repository;
    this.rootSessionId = options.rootSessionId;
    this.runtimeGeneration = options.runtimeGeneration;
  }

  async readSegment<T>(name: string): Promise<T[]> {
    const aggregate = await this.repository.load();
    const state = parseState(aggregate?.state);
    const value = state[name];
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error(`Host concurrency segment ${name} is invalid.`);
    return structuredClone(value) as T[];
  }

  mutateSegment<T>(
    name: string,
    eventType: string,
    eventPayload: unknown,
    reducer: (items: T[]) => T[],
  ): Promise<T[]> {
    const prior = this.queue.catch(() => undefined);
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    this.queue = prior.then(() => gate);
    return prior
      .then(async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const aggregate = await this.repository.load();
          const state = parseState(aggregate?.state);
          const current = state[name];
          if (current !== undefined && !Array.isArray(current))
            throw new Error(`Host concurrency segment ${name} is invalid.`);
          const items = reducer(structuredClone((current ?? []) as T[]));
          if (items.length > 1024)
            throw new Error(`Host concurrency segment ${name} exceeds 1024 records.`);
          const expectedRevision = aggregate?.revision ?? 0;
          const nextState = { ...state, version: 1, [name]: items };
          const projection = projectState(
            nextState,
            aggregate?.projection,
            this.rootSessionId,
            expectedRevision + 1,
          );
          try {
            await this.repository.transact({
              version: 1,
              transactionId: `host-state-transaction-${randomUUID()}`,
              rootSessionId: this.rootSessionId,
              runtimeGeneration: this.runtimeGeneration,
              expectedRevision,
              events: [
                {
                  eventId: `host-state-event-${randomUUID()}`,
                  type: eventType,
                  payload: eventPayload,
                },
              ],
              state: nextState,
              projection,
            });
            return items;
          } catch (error) {
            if (
              attempt === 1 ||
              !/revision/i.test(error instanceof Error ? error.message : String(error))
            )
              throw error;
          }
        }
        throw new Error("Host concurrency transaction retry exhausted.");
      })
      .finally(resolveGate);
  }
}

function parseState(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return { version: 1 };
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as any).version !== 1)
    throw new Error("Host concurrency aggregate state is invalid.");
  return value as Record<string, unknown>;
}
function projectState(
  state: Record<string, unknown>,
  current: ConcurrencyProjectionV1 | undefined,
  rootSessionId: string,
  revision: number,
): ConcurrencyProjectionV1 {
  const tasks = Array.isArray(state.tasks) ? (state.tasks as any[]) : [];
  const workspaces = Array.isArray(state.workspaces) ? (state.workspaces as any[]) : [];
  const sources = Array.isArray(state.sharedSources) ? (state.sharedSources as any[]) : [];
  const reviews = Array.isArray(state.reviews) ? (state.reviews as any[]) : [];
  const taskLimit = tasks.slice(-256);
  const workspaceLimit = workspaces.slice(-256);
  return {
    ...(current ?? {
      version: 1,
      children: [],
      inactiveChildCount: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      telemetryGapCount: 0,
    }),
    rootSessionId,
    revision,
    generatedAt: new Date().toISOString(),
    tasks: taskLimit.map((task) => ({
      taskId: task.taskId,
      ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
      ownerRole: task.ownerRole,
      objective: task.assignment?.objective ?? task.goal?.objective ?? "Task",
      executionPhase: task.execution?.phase ?? "unknown",
      childTaskCount: task.childTaskIds?.length ?? 0,
      planRevisionCount: task.planRevisions?.length ?? 0,
      directionCount: task.directions?.length ?? 0,
      updatedAt: task.updatedAt,
    })),
    inactiveTaskCount: Math.max(0, tasks.length - taskLimit.length),
    workspaces: workspaceLimit.map((workspace) => {
      const workspaceId = workspace.identity?.workspaceId ?? workspace.workspaceId;
      const review = reviews.find(
        (candidate) =>
          candidate.bundle?.workspaceId === workspaceId &&
          (candidate.phase === "reported" || candidate.phase === "approved"),
      );
      const findings = review?.report?.findings ?? [];
      const findingCounts = {
        p0: findings.filter((finding: any) => finding.severity === "p0").length,
        p1: findings.filter((finding: any) => finding.severity === "p1").length,
        p2: findings.filter((finding: any) => finding.severity === "p2").length,
        p3: findings.filter((finding: any) => finding.severity === "p3").length,
        p4: findings.filter((finding: any) => finding.severity === "p4").length,
      };
      const changedPaths = new Set(
        (workspace.claims ?? []).flatMap((claim: any) => claim.mutatedPaths ?? []),
      );
      return {
        workspaceId,
        ...(workspace.taskId ? { taskId: workspace.taskId } : {}),
        phase: workspace.phase,
        ...(changedPaths.size ? { changedPathCount: changedPaths.size } : {}),
        ...(findings.length ? { findingCounts } : {}),
        receiptDigests: [
          review?.approval?.receiptDigest,
          workspace.integrationReceipt?.receiptDigest,
          workspace.verificationReceipt?.jjEvidenceDigest,
        ].filter(Boolean),
        ...(workspace.phase === "incident" ? { incidentSummary: workspace.reason } : {}),
        updatedAt: workspace.updatedAt,
      };
    }),
    activeClaimCount:
      sources.reduce(
        (total, source) =>
          total +
          (source.claims ?? []).filter(
            (claim: any) => claim.phase === "active" || claim.phase === "checkpointing",
          ).length,
        0,
      ) +
      workspaces.reduce(
        (total, workspace) =>
          total +
          (workspace.claims ?? []).filter(
            (claim: any) => claim.phase === "active" || claim.phase === "checkpointing",
          ).length,
        0,
      ),
    unansweredQuestionCount:
      current?.children.filter((child) => child.phase === "awaiting_parent").length ?? 0,
    truncated:
      (current?.inactiveChildCount ?? 0) > 0 ||
      tasks.length > taskLimit.length ||
      workspaces.length > workspaceLimit.length,
  };
}
