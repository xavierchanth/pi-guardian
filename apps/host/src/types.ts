export type RuntimeSnapshot =
  | { state: "unloaded" }
  | { state: "starting"; generation: number }
  | { state: "ready"; generation: number }
  | { state: "interrupted"; generation: number }
  | { state: "failed"; generation: number };

export type ForegroundSnapshot =
  | { state: "idle"; last_stop_reason: string | null }
  | { state: "running"; operation_id: string }
  | { state: "requires_action"; operation_id: string; interaction_id: string };

export interface PiSessionSnapshot {
  sessionId: string;
  sessionFile: string;
  cwd: string;
}

export interface SessionSnapshot {
  sessionId: string;
  revision: number;
  runtimeGeneration: number;
  runtime: RuntimeSnapshot;
  foreground: ForegroundSnapshot;
  piSession: PiSessionSnapshot | null;
  attachmentCount: number;
  activeClientId: string | null;
  controlEpoch: number;
}
