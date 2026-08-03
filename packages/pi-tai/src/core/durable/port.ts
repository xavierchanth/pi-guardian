import type { LifecycleRecord } from "../subagents/lifecycle.ts";

export interface DurableRecordSummary {
  readonly durableId: string;
  readonly displayId: string;
  /** Authoritative allocation sequence; displayId is an opaque user-facing label. */
  readonly sequence: number;
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

/** C1 durable-record authority. Storage implementations may outlive manager residency. */
export interface DurableRecordStore {
  ingest(records: Iterable<LifecycleRecord>): void;
  note(summary: DurableRecordSummary, authoritative?: boolean): void;
  get(durableId: string): DurableRecordSummary | undefined;
  isInherited(durableId: string): boolean;
  counts(): RecordCounts;
}
