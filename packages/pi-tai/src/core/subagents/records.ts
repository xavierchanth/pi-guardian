import type { DurableRecordStore, DurableRecordSummary, RecordCounts } from "../durable/port.ts";
import type { LifecycleRecord } from "./lifecycle.ts";

export type { DurableRecordSummary, RecordCounts } from "../durable/port.ts";

/** In-memory C1 implementation. Residency pruning never removes records from this store. */
export class InMemoryRecordStore implements DurableRecordStore {
  private readonly records = new Map<string, DurableRecordSummary>();
  private readonly rootSessionId?: string;
  constructor(rootSessionId?: string) {
    this.rootSessionId = rootSessionId;
  }

  ingest(records: Iterable<LifecycleRecord>): void {
    for (const record of records) this.note(record);
  }

  note(summary: DurableRecordSummary, authoritative = false): void {
    const prior = this.records.get(summary.durableId);
    // Replayed facts keep their incumbent on a timestamp tie. Live authoritative
    // transitions are causally ordered and must win even within one millisecond.
    if (
      prior &&
      (authoritative ? prior.updatedAt > summary.updatedAt : prior.updatedAt >= summary.updatedAt)
    )
      return;
    this.records.set(summary.durableId, summary);
  }

  get(durableId: string): DurableRecordSummary | undefined {
    return this.records.get(durableId);
  }

  isInherited(durableId: string): boolean {
    const record = this.records.get(durableId);
    return (
      !!record?.rootSessionId && !!this.rootSessionId && record.rootSessionId !== this.rootSessionId
    );
  }

  counts(): RecordCounts {
    let unarchived = 0;
    let archived = 0;
    let inherited = 0;
    for (const record of this.records.values()) {
      if (this.isInherited(record.durableId)) inherited += 1;
      else if (record.archivedAt !== undefined) archived += 1;
      else unarchived += 1;
    }
    return { unarchived, archived, inherited, total: this.records.size };
  }

  /** Compatibility utility; future explicit cleanup may use a separate port revision. */
  forget(durableId: string): void {
    this.records.delete(durableId);
  }
}

/** @deprecated Use InMemoryRecordStore. */
export const SubagentRecordIndex = InMemoryRecordStore;
/** @deprecated Use InMemoryRecordStore. */
export type SubagentRecordIndex = InMemoryRecordStore;
