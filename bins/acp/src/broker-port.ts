export interface BrokerSessionSummary {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
}

export type BrokerSessionEvent =
  | { type: "user_message"; messageId: string; content: string }
  | { type: "assistant_text_delta"; messageId: string; delta: string }
  | { type: "foreground_running" }
  | { type: "foreground_idle"; stopReason?: "end_turn" | "cancelled" | "refusal" | string };

export interface BrokerPort {
  create(input: { clientId: string; cwd: string }): Promise<BrokerSessionSummary>;
  list(input: { cwd?: string; cursor?: string }): Promise<{
    sessions: BrokerSessionSummary[];
    nextCursor?: string;
  }>;
  resume(input: { clientId: string; sessionId: string; cwd: string }): Promise<BrokerSessionSummary>;
  close(input: { clientId: string; sessionId: string }): Promise<void>;
  prompt(input: { clientId: string; sessionId: string; text: string }): Promise<void>;
  cancel(input: { clientId: string; sessionId: string }): Promise<void>;
  subscribe(
    input: { clientId: string; sessionId: string; replayFromStart: boolean },
    onEvent: (event: BrokerSessionEvent) => void | Promise<void>,
  ): Promise<() => void>;
}
