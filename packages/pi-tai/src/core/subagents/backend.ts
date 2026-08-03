import type { BackendName, SpawnTask, SubagentEvent } from "./domain.ts";

/**
 * What a runtime must provide to host subagents.
 *
 * Deliberately small: spawn, stream events, steer, interrupt. Workspace
 * isolation is not part of this contract — an isolated child is simply one
 * whose `cwd` happens to be a managed workspace, which is why every backend gets
 * isolation for free.
 */
export interface SubagentBackend {
  readonly name: BackendName;
  readonly capabilities: BackendCapabilities;
  /** Whether this backend can run here: binary present, SDK installed, credentials set. */
  available(): Promise<AvailabilityResult>;
  spawn(task: SpawnTask): Promise<SubagentSession>;
}

export type LiveInputMode = "steer" | "followUp";
export type SendMode = LiveInputMode | "continue";
export type NotDeliveredReason = "settled" | "saturated" | "closed" | "precondition";

/** A send rejection that proves the backend accepted no input. */
export class SendNotDeliveredError extends Error {
  readonly name = "SendNotDeliveredError";
  readonly reason: NotDeliveredReason;
  constructor(message: string, reason: NotDeliveredReason) {
    super(message);
    this.reason = reason;
  }
}

export interface BackendCapabilities {
  /** Operations accepted while a run is live. */
  readonly liveInput: readonly LiveInputMode[];
  /** How a settled conversation can be continued. */
  readonly settledContinuation: "in-place" | "respawn" | "none";
  readonly modelSelection: boolean;
  readonly reasoningEffort: boolean;
}

export type AvailabilityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface SubagentSession {
  /** Normalised event stream; completes after the terminal `run_settled`. */
  readonly events: AsyncIterable<SubagentEvent>;
  /** Narrows the backend's advertised live-input set after session negotiation. */
  readonly liveInput?: readonly LiveInputMode[];
  /**
   * Handle for continuing this conversation once it has settled. Populated by
   * harnesses that support it; `undefined` means every turn starts fresh.
   */
  readonly resumeToken?: string;
  /** Private durable handle captured for later explicit reopen; never exposed by tools/UI. */
  readonly sessionFile?: string;
  /** Subscribes to private handle discovery; current handle is replayed immediately. */
  onResumeHandle?(callback: (handle: string) => void): () => void;
  /** Starts another turn on the same retained backend session, when supported. */
  continueInPlace?(text: string): Promise<void>;
  /** Performs one explicitly selected operation; the manager checks capability/state. */
  send(text: string, mode: SendMode): Promise<void>;
  interrupt(): Promise<void>;
  dispose(): void;
}

export class BackendRegistry {
  private readonly backends = new Map<BackendName, SubagentBackend>();

  constructor(backends: readonly SubagentBackend[] = []) {
    for (const backend of backends) this.backends.set(backend.name, backend);
  }

  register(backend: SubagentBackend): void {
    this.backends.set(backend.name, backend);
  }

  get(name: BackendName): SubagentBackend | undefined {
    return this.backends.get(name);
  }

  /** Registered backend names, in registration order. `pi` is always first. */
  names(): BackendName[] {
    return [...this.backends.keys()];
  }

  async require(name: BackendName): Promise<SubagentBackend> {
    const backend = this.backends.get(name);
    if (!backend) {
      throw new Error(
        `Backend "${name}" is not enabled. Enabled backends: ${this.names().join(", ") || "none"}.`,
      );
    }
    const availability = await backend.available();
    if (!availability.ok)
      throw new Error(`Backend "${name}" is unavailable: ${availability.reason}`);
    return backend;
  }
}

/**
 * Turns a push-style callback API into the pull-style stream backends expose.
 * Backends built on event emitters or process stdout use this rather than each
 * reinventing buffering and completion.
 */
export class EventChannel {
  private readonly buffer: SubagentEvent[] = [];
  private readonly waiters: ((value: IteratorResult<SubagentEvent>) => void)[] = [];
  private closed = false;

  push(event: SubagentEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.buffer.push(event);
    if (event.type === "run_settled" || event.type === "backend_error") this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  get events(): AsyncIterable<SubagentEvent> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<SubagentEvent> {
        return {
          next(): Promise<IteratorResult<SubagentEvent>> {
            const buffered = self.buffer.shift();
            if (buffered) return Promise.resolve({ value: buffered, done: false });
            if (self.closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => self.waiters.push(resolve));
          },
        };
      },
    };
  }
}
