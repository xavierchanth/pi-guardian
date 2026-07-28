import type { PersistedChildEventV4 } from "./persistence.ts";

export type ChildWaitResult =
  | { reason: "event"; event: PersistedChildEventV4 }
  | { reason: "user_input" | "cancelled" | "timeout" };

interface Waiter {
  callerId: string;
  contextIds?: Set<string>;
  kinds?: Set<PersistedChildEventV4["kind"]>;
  resolve: (result: ChildWaitResult) => void;
  cleanup: () => void;
}

export class ChildEventWaitRegistry {
  private readonly waiters = new Map<string, Waiter>();

  wait(input: {
    callerId: string;
    contextIds?: readonly string[];
    kinds?: readonly PersistedChildEventV4["kind"][];
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<ChildWaitResult> {
    if (this.waiters.has(input.callerId)) throw new Error(`Context ${input.callerId} already has an active child-event wait.`);
    if (input.signal?.aborted) return Promise.resolve({ reason: "cancelled" });
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => finish({ reason: "cancelled" });
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        this.waiters.delete(input.callerId);
      };
      const finish = (result: ChildWaitResult) => {
        if (!this.waiters.has(input.callerId)) return;
        cleanup();
        resolve(result);
      };
      this.waiters.set(input.callerId, {
        callerId: input.callerId,
        ...(input.contextIds ? { contextIds: new Set(input.contextIds) } : {}),
        ...(input.kinds ? { kinds: new Set(input.kinds) } : {}),
        resolve: finish,
        cleanup,
      });
      input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.timeoutMs !== undefined) timer = setTimeout(() => finish({ reason: "timeout" }), input.timeoutMs);
    });
  }

  notify(event: PersistedChildEventV4): void {
    for (const waiter of this.waiters.values()) {
      if (waiter.contextIds && !waiter.contextIds.has(event.contextId)) continue;
      if (waiter.kinds && !waiter.kinds.has(event.kind)) continue;
      waiter.resolve({ reason: "event", event });
    }
  }

  interrupt(callerId: string): boolean { return this.resolve(callerId, "user_input"); }
  cancel(callerId: string): boolean { return this.resolve(callerId, "cancelled"); }

  clear(reason: "cancelled" | "user_input" = "cancelled"): void {
    for (const waiter of [...this.waiters.values()]) waiter.resolve({ reason });
  }

  has(callerId: string): boolean { return this.waiters.has(callerId); }

  private resolve(callerId: string, reason: "user_input" | "cancelled"): boolean {
    const waiter = this.waiters.get(callerId);
    if (!waiter) return false;
    waiter.resolve({ reason });
    return true;
  }
}
