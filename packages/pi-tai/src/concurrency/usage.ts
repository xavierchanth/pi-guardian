import { rm } from "node:fs/promises";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ChildContextStore, PersistedUsageEntryV4 } from "./persistence.ts";
import { privateContextPaths } from "./persistence.ts";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export class ChildUsageLedger {
  private readonly store: ChildContextStore;
  private readonly now: () => string;

  constructor(store: ChildContextStore, now: () => string = () => new Date().toISOString()) {
    this.store = store;
    this.now = now;
  }

  async recordAssistant(input: {
    contextId: string;
    cycleId: string;
    role: string;
    provider: string;
    model: string;
    message: AssistantMessage;
  }): Promise<PersistedUsageEntryV4 | undefined> {
    const usage = input.message.usage;
    if (!usage) return undefined;
    const messageId = String((input.message as AssistantMessage & { id?: string; timestamp?: number }).id
      ?? (input.message as AssistantMessage & { timestamp?: number }).timestamp
      ?? `${usage.input}:${usage.output}:${usage.cacheRead}:${usage.cacheWrite}`);
    const usageEventId = `${input.cycleId}_${messageId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
    const entry: PersistedUsageEntryV4 = {
      usageEventId,
      contextId: input.contextId,
      cycleId: input.cycleId,
      provider: input.provider,
      model: input.model,
      role: input.role,
      messageId,
      quality: "message",
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      cost: usage.cost.total,
      recordedAt: this.now(),
    };
    let inserted = false;
    await this.store.update(input.contextId, (context) => {
      if (context.usage.some((candidate) => candidate.usageEventId === usageEventId)) return context;
      inserted = true;
      return { ...context, usage: [...context.usage, entry], updatedAt: this.now() };
    });
    return inserted ? entry : undefined;
  }

  async totals(rootSessionId: string, contextId?: string): Promise<{
    total: UsageTotals;
    byModel: Record<string, UsageTotals>;
    byRole: Record<string, UsageTotals>;
    byContext: Record<string, UsageTotals>;
    byExecutionCycle: Record<string, UsageTotals>;
  }> {
    const records = (await this.store.list()).filter((record) => record.rootSessionId === rootSessionId);
    const selectedIds = contextId ? descendants(records, contextId) : new Set(records.map((record) => record.contextId));
    const entries = records.filter((record) => selectedIds.has(record.contextId)).flatMap((record) => record.usage);
    return {
      total: sum(entries),
      byModel: group(entries, (entry) => `${entry.provider}/${entry.model}`),
      byRole: group(entries, (entry) => entry.role),
      byContext: group(entries, (entry) => entry.contextId),
      byExecutionCycle: group(entries, (entry) => entry.cycleId),
    };
  }
}

export class ChildJournalRetention {
  private readonly store: ChildContextStore;
  private readonly stateRoot: string;
  private readonly now: () => string;

  constructor(store: ChildContextStore, stateRoot: string, now: () => string = () => new Date().toISOString()) {
    this.store = store;
    this.stateRoot = stateRoot;
    this.now = now;
  }

  async closeClean(contextId: string, workspaceCustodyClosed: boolean): Promise<void> {
    const context = await this.store.get(contextId);
    if (!context) throw new Error(`Unknown child context: ${contextId}`);
    if (!workspaceCustodyClosed) throw new Error("Raw child journal cannot be removed while workspace custody is unresolved.");
    if (!["completed", "blocked", "failed", "cancelled"].includes(context.execution.phase)) {
      throw new Error(`Raw child journal cannot be removed from ${context.execution.phase} context.`);
    }
    const terminalId = "terminalEventId" in context.execution ? context.execution.terminalEventId : undefined;
    const terminal = terminalId ? context.events.find((event) => event.eventId === terminalId) : undefined;
    if (!terminal || terminal.delivery.phase !== "acknowledged") {
      throw new Error("Raw child journal cannot be removed before terminal acknowledgement.");
    }
    await rm(privateContextPaths(this.stateRoot, contextId).root, { recursive: true, force: true });
    await this.store.update(contextId, (current) => ({ ...current, closedAt: this.now(), updatedAt: this.now() }));
  }
}

function empty(): UsageTotals { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }; }
function add(target: UsageTotals, entry: PersistedUsageEntryV4): void {
  target.input += entry.input;
  target.output += entry.output;
  target.cacheRead += entry.cacheRead;
  target.cacheWrite += entry.cacheWrite;
  target.cost += entry.cost;
}
function sum(entries: readonly PersistedUsageEntryV4[]): UsageTotals { const total = empty(); for (const entry of entries) add(total, entry); return total; }
function group(entries: readonly PersistedUsageEntryV4[], key: (entry: PersistedUsageEntryV4) => string): Record<string, UsageTotals> {
  const result: Record<string, UsageTotals> = {};
  for (const entry of entries) add(result[key(entry)] ??= empty(), entry);
  return result;
}
function descendants(records: readonly { contextId: string; parentContextId?: string }[], root: string): Set<string> {
  const selected = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) if (record.parentContextId && selected.has(record.parentContextId) && !selected.has(record.contextId)) {
      selected.add(record.contextId);
      changed = true;
    }
  }
  return selected;
}
