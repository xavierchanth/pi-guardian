import type { ConcurrencyProjectionV1, ConcurrencyTransactionV1 } from "./productization.ts";
import { validateConcurrencyProjection, validateConcurrencyTransaction } from "./productization.ts";

export interface CoreAggregateSnapshotV1 {
  aggregateId: string;
  revision: number;
  runtimeGeneration: number;
  state: unknown;
  projection: ConcurrencyProjectionV1;
  updatedAt: string;
}

export interface HostServiceClientPort {
  request<T = unknown>(method: string, params: unknown): Promise<T>;
}

export class HostConcurrencyRepository {
  private readonly services: HostServiceClientPort;
  constructor(services: HostServiceClientPort) {
    this.services = services;
  }

  async load(): Promise<CoreAggregateSnapshotV1 | undefined> {
    const value = await this.services.request<unknown>("core.load", {});
    if (value === null || value === undefined) return undefined;
    return parseAggregate(value);
  }

  async transact(transaction: ConcurrencyTransactionV1): Promise<CoreAggregateSnapshotV1> {
    validateConcurrencyTransaction(transaction);
    const value = await this.services.request<unknown>("core.transact", {
      transactionId: transaction.transactionId,
      expectedRevision: transaction.expectedRevision,
      events: transaction.events,
      state: transaction.state,
      projection: transaction.projection,
    });
    const aggregate = parseAggregate(value);
    if (aggregate.revision !== transaction.expectedRevision + 1)
      throw new Error("Host committed an unexpected concurrency revision.");
    return aggregate;
  }
}

function parseAggregate(value: unknown): CoreAggregateSnapshotV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Host core aggregate is invalid.");
  const input = value as Record<string, unknown>;
  if (
    typeof input.aggregateId !== "string" ||
    typeof input.updatedAt !== "string" ||
    !Number.isSafeInteger(input.revision) ||
    !Number.isSafeInteger(input.runtimeGeneration)
  ) {
    throw new Error("Host core aggregate identity is invalid.");
  }
  if (input.state === undefined) throw new Error("Host core aggregate state is missing.");
  const projection = validateConcurrencyProjection(input.projection as ConcurrencyProjectionV1);
  if (projection.revision !== input.revision)
    throw new Error("Host aggregate and concurrency projection revisions differ.");
  return {
    aggregateId: input.aggregateId,
    revision: input.revision as number,
    runtimeGeneration: input.runtimeGeneration as number,
    state: input.state,
    projection,
    updatedAt: input.updatedAt,
  };
}
