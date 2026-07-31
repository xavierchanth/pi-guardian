/**
 * Holds results of subagents that settled while nobody was waiting on them.
 *
 * This is what lets the tool surface stay small. The orchestrator spawns and
 * keeps working; when a child finishes, its result is parked here and flushed
 * into the conversation at the next idle point. Without it, the parent has to
 * poll, and polling is what makes delegation feel like babysitting.
 */
export interface DeferredResult {
  readonly id: string;
  readonly text: string;
}

export class DeferredResultDelivery {
  private readonly pending = new Map<string, DeferredResult>();

  defer(result: DeferredResult): void {
    this.pending.set(result.id, result);
  }

  /** Removes one result without delivering it — used when `wait` returns it instead. */
  consume(id: string): DeferredResult | undefined {
    const result = this.pending.get(id);
    this.pending.delete(id);
    return result;
  }

  /** Takes everything pending, in settle order. */
  drain(): DeferredResult[] {
    const results = [...this.pending.values()];
    this.pending.clear();
    return results;
  }

  get size(): number {
    return this.pending.size;
  }

  clear(): void {
    this.pending.clear();
  }
}
