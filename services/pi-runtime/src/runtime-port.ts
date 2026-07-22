import type {
  RuntimeCapabilities,
  SessionCreateParams,
  SessionInfo,
  SessionOpenParams,
  SessionPromptParams,
  SessionSetModelParams,
  SessionSetThinkingParams,
  SessionTextParams,
  ThinkingInfo,
  ModelInfo,
} from "@pi-tai/runtime-protocol";

export interface RuntimeEventInput {
  event: string;
  data: unknown;
  commandId?: string;
  sessionId?: string;
  turnId?: string;
}

export type RuntimeEventSink = (event: RuntimeEventInput) => void;

export interface PromptStart {
  accepted: boolean;
  completion: Promise<void>;
}

export interface RuntimePort {
  capabilities(): Promise<RuntimeCapabilities>;
  createSession(params: SessionCreateParams, emit: RuntimeEventSink): Promise<SessionInfo>;
  openSession(params: SessionOpenParams, emit: RuntimeEventSink): Promise<SessionInfo>;
  startPrompt(params: SessionPromptParams, commandId: string, emit: RuntimeEventSink): Promise<PromptStart>;
  steer(params: SessionTextParams): Promise<boolean>;
  followUp(params: SessionTextParams): Promise<boolean>;
  cancel(turnId: string): Promise<boolean>;
  setModel(params: SessionSetModelParams): Promise<ModelInfo>;
  setThinking(params: SessionSetThinkingParams): Promise<ThinkingInfo>;
  disposeSession(): Promise<void>;
  shutdown(): Promise<void>;
}
