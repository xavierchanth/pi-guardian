import type { LifecycleRecord } from "./lifecycle.ts";

export interface DurableRecordSummary {
  readonly durableId: string;
  readonly displayId: string;
  readonly rootSessionId?: string;
  readonly disposition: LifecycleRecord["disposition"];
  readonly archivedAt?: string;
  readonly archivedBy?: "user" | "auto_done";
  readonly updatedAt: string;
}

export interface RecordCounts {
  readonly unarchived: number;
  readonly archived: number;
  readonly inherited: number;
  readonly total: number;
}

/** Durable capacity authority. Residency pruning must never remove records from this index. */
export class SubagentRecordIndex {
  private readonly records = new Map<string, DurableRecordSummary>();
  private readonly rootSessionId?: string;
  constructor(rootSessionId?: string) {
    this.rootSessionId = rootSessionId;
  }

  ingest(records: Iterable<LifecycleRecord>): void {
    for (const record of records) this.note(record);
  }

  note(summary: DurableRecordSummary): void {
    const prior = this.records.get(summary.durableId);
    if (prior && prior.updatedAt >= summary.updatedAt) return;
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

  /** Reserved for explicit retention cleanup; never residency pruning. */
  forget(durableId: string): void {
    this.records.delete(durableId);
  }
}
