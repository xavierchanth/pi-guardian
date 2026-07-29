import type { BackendRegistry, SubagentBackend, SubagentSession } from "./backend.ts";
import {
  applyEvent,
  emptySnapshot,
  type BackendName,
  type SpawnTask,
  type SubagentSnapshot,
} from "./domain.ts";
import { DeferredResultDelivery } from "./result-delivery.ts";

export const MAX_RUNNING_SUBAGENTS = 4;
export const MAX_TRACKED_SUBAGENTS = 64;

export interface SpawnRequest {
  readonly backend: BackendName;
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly cwd: string;
  readonly title: string;
  readonly workspaceId?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly effort?: string;
  readonly tools?: readonly string[];
}

export interface WaitResult extends Iterable<SubagentSnapshot> {
  readonly settled: readonly SubagentSnapshot[];
  readonly pending: readonly string[];
  readonly reason: "settled" | "user-interrupted";
}

export interface SubagentManagerOptions {
  readonly registry: BackendRegistry;
  readonly maxRunning?: number;
  readonly maxTracked?: number;
  readonly now?: () => string;
  /**
   * Called once per subagent when it reaches a terminal state, before the result
   * is deferred. The workspace layer hooks in here to reclaim or flag isolation
   * on failure, which is what keeps a crashed spawn from leaking a workspace.
   */
  readonly onSettled?: (snapshot: SubagentSnapshot) => void | Promise<void>;
}

interface Entry {
  snapshot: SubagentSnapshot;
  session?: SubagentSession;
  /** Kept so a settled subagent can be resumed on a harness that supports it. */
  readonly backend: SubagentBackend;
  task: SpawnTask;
  settled: Promise<SubagentSnapshot>;
  resolveSettled: (snapshot: SubagentSnapshot) => void;
  readonly abort: AbortController;
}

/**
 * Owns the lifecycle of every subagent: reservation, event folding, settlement,
 * and deferred result handoff. Backends supply behaviour; this class supplies
 * the bookkeeping that used to be spread across the tool handlers.
 */
export class SubagentManager {
  private readonly registry: BackendRegistry;
  private readonly maxRunning: number;
  private readonly maxTracked: number;
  private readonly clock: () => string;
  private readonly onSettled?: (snapshot: SubagentSnapshot) => void | Promise<void>;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(snapshot: SubagentSnapshot) => void>();
  readonly delivery = new DeferredResultDelivery();
  /**
   * Counts reservations, not running sessions. Incremented synchronously in
   * `spawn` before the first await so two tool calls in one assistant turn
   * cannot both observe a free slot and race past the cap.
   */
  private reserved = 0;
  private sequence = 0;

  constructor(options: SubagentManagerOptions) {
    this.registry = options.registry;
    this.maxRunning = options.maxRunning ?? MAX_RUNNING_SUBAGENTS;
    this.maxTracked = options.maxTracked ?? MAX_TRACKED_SUBAGENTS;
    this.clock = options.now ?? (() => new Date().toISOString());
    if (options.onSettled) this.onSettled = options.onSettled;
  }

  subscribe(listener: (snapshot: SubagentSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): SubagentSnapshot[] {
    return [...this.entries.values()].map((entry) => entry.snapshot);
  }

  get(id: string): SubagentSnapshot | undefined {
    return this.entries.get(id)?.snapshot;
  }

  get runningCount(): number {
    return [...this.entries.values()].filter((entry) => entry.snapshot.status === "running").length;
  }

  async spawn(request: SpawnRequest): Promise<SubagentSnapshot> {
    if (this.reserved >= this.maxRunning) {
      throw new Error(`At most ${this.maxRunning} subagents may run at once; wait for one to finish.`);
    }
    this.reserved += 1;
    const id = `sa-${++this.sequence}`;
    try {
      const backend = await this.registry.require(request.backend);
      const abort = new AbortController();
      let resolveSettled: (snapshot: SubagentSnapshot) => void = () => {};
      const settled = new Promise<SubagentSnapshot>((resolve) => { resolveSettled = resolve; });
      const entry: Entry = {
        snapshot: emptySnapshot({
          id,
          backend: request.backend,
          title: request.title,
          cwd: request.cwd,
          ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
          createdAt: this.clock(),
        }),
        settled,
        resolveSettled,
        abort,
        backend,
        task: undefined as unknown as SpawnTask,
      };
      this.entries.set(id, entry);
      this.prune();

      const task: SpawnTask = {
        id,
        prompt: request.prompt,
        systemPrompt: request.systemPrompt,
        cwd: request.cwd,
        title: request.title,
        ...(request.model ? { model: request.model } : {}),
        ...(request.provider ? { provider: request.provider } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
        ...(request.tools ? { tools: request.tools } : {}),
        signal: abort.signal,
      };
      entry.task = task;
      try {
        entry.session = await backend.spawn(task);
      } catch (error) {
        this.finish(entry, { type: "backend_error", message: describe(error) });
        throw error;
      }
      void this.pump(entry, entry.session);
      return entry.snapshot;
    } catch (error) {
      this.reserved = Math.max(0, this.reserved - 1);
      throw error;
    }
  }

  /** Waits for all listed agents, or returns a partial snapshot on foreground input. */
  async wait(ids: readonly string[], signal?: AbortSignal, interruption?: AbortSignal): Promise<WaitResult> {
    const unique = [...new Set(ids)];
    const missing = unique.filter((id) => !this.entries.has(id));
    if (missing.length) throw new Error(`Unknown subagent(s): ${missing.join(", ")}.`);

    return new Promise<WaitResult>((resolve, reject) => {
      let done = false;
      const cleanup = () => {
        signal?.removeEventListener("abort", cancel);
        interruption?.removeEventListener("abort", interrupt);
      };
      const finish = (reason: WaitResult["reason"]) => {
        if (done) return;
        done = true;
        cleanup();
        const settled = unique
          .map((id) => this.entries.get(id)!.snapshot)
          .filter((snapshot) => snapshot.status !== "running");
        const settledIds = new Set(settled.map(({ id }) => id));
        for (const id of settledIds) this.delivery.consume(id);
        resolve({
          settled,
          pending: unique.filter((id) => !settledIds.has(id)),
          reason,
          [Symbol.iterator]: () => settled[Symbol.iterator](),
        });
      };
      const cancel = () => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error("Wait was cancelled."));
      };
      const interrupt = () => finish("user-interrupted");
      if (signal?.aborted) return cancel();
      if (interruption?.aborted) return interrupt();
      signal?.addEventListener("abort", cancel, { once: true });
      interruption?.addEventListener("abort", interrupt, { once: true });
      void Promise.all(unique.map((id) => this.entries.get(id)!.settled)).then(() => finish("settled"), (error) => {
        if (done) return;
        done = true;
        cleanup();
        reject(error);
      });
    });
  }

  /**
   * Sends a message to a subagent.
   *
   * A running subagent is steered in place. A settled one is resumed — a new run
   * on the same conversation — when its harness supports that, which is how a
   * one-shot subagent becomes a thinking partner without holding a process open
   * between turns.
   */
  async send(id: string, text: string): Promise<void> {
    const entry = this.requireEntry(id);
    if (entry.snapshot.status === "running") {
      if (!entry.session) throw new Error(`Subagent ${id} has no live session.`);
      await entry.session.send(text);
      return;
    }
    const resumeToken = entry.session?.resumeToken;
    if (!entry.backend.capabilities.resumable || !resumeToken) {
      throw new Error(
        `Subagent ${id} has finished and the ${entry.snapshot.backend} harness cannot continue it; spawn a new subagent instead.`,
      );
    }
    await this.resume(entry, text, resumeToken);
  }

  /** Starts a follow-up run in place, reusing the entry so the id stays stable. */
  private async resume(entry: Entry, text: string, resumeToken: string): Promise<void> {
    if (this.reserved >= this.maxRunning) {
      throw new Error(`At most ${this.maxRunning} subagents may run at once; wait for one to finish.`);
    }
    this.reserved += 1;
    const task: SpawnTask = { ...entry.task, prompt: text, resumeToken };
    let session: SubagentSession;
    try {
      session = await entry.backend.spawn(task);
    } catch (error) {
      this.reserved = Math.max(0, this.reserved - 1);
      throw error;
    }
    entry.task = task;
    entry.session?.dispose();
    entry.session = session;
    // Reopen the entry so `wait` and result delivery work exactly as on a first run.
    let resolveSettled: (snapshot: SubagentSnapshot) => void = () => {};
    const settled = new Promise<SubagentSnapshot>((resolve) => { resolveSettled = resolve; });
    Object.assign(entry, { settled, resolveSettled });
    this.update(entry, { ...entry.snapshot, status: "running", latestText: "", liveTools: [] });
    this.delivery.consume(entry.snapshot.id);
    void this.pump(entry, session);
  }

  async cancel(ids: readonly string[]): Promise<SubagentSnapshot[]> {
    const cancelled: SubagentSnapshot[] = [];
    for (const id of new Set(ids)) {
      const entry = this.entries.get(id);
      if (!entry) throw new Error(`Unknown subagent ${id}.`);
      if (entry.snapshot.status !== "running") {
        cancelled.push(entry.snapshot);
        continue;
      }
      entry.abort.abort();
      try {
        await entry.session?.interrupt();
      } catch {
        // A backend that cannot interrupt cleanly still settles below.
      }
      this.finish(entry, { type: "run_settled", outcome: "interrupted" });
      cancelled.push(entry.snapshot);
    }
    return cancelled;
  }

  /** Cancels everything and releases backend resources. */
  async shutdown(): Promise<void> {
    const running = this.list().filter((snapshot) => snapshot.status === "running").map((snapshot) => snapshot.id);
    if (running.length) await this.cancel(running);
    for (const entry of this.entries.values()) entry.session?.dispose();
    this.entries.clear();
    this.delivery.clear();
    this.reserved = 0;
  }

  private async pump(entry: Entry, session: SubagentSession): Promise<void> {
    try {
      for await (const event of session.events) {
        if (event.type === "run_settled" || event.type === "backend_error") {
          this.finish(entry, event);
          return;
        }
        this.update(entry, applyEvent(entry.snapshot, event, this.clock()));
      }
      // The stream ended without a terminal event; treat that as a backend fault
      // rather than leaving the entry running forever.
      if (entry.snapshot.status === "running") {
        this.finish(entry, { type: "backend_error", message: "Backend closed the event stream without settling." });
      }
    } catch (error) {
      this.finish(entry, { type: "backend_error", message: describe(error) });
    }
  }

  private finish(entry: Entry, event: Parameters<typeof applyEvent>[1]): void {
    if (entry.snapshot.status !== "running") return;
    this.update(entry, applyEvent(entry.snapshot, event, this.clock()));
    this.reserved = Math.max(0, this.reserved - 1);
    const snapshot = entry.snapshot;
    // Defer before resolving: a `wait` that is already pending must be able to
    // consume this result, which it can only do once it exists.
    this.delivery.defer({ id: snapshot.id, text: snapshot.finalText || snapshot.errorText || "" });
    entry.resolveSettled(snapshot);
    // The hook runs after settlement so a slow or broken workspace reclaim
    // cannot stall the parent's `wait`.
    void Promise.resolve(this.onSettled?.(snapshot)).catch(() => {});
  }

  private update(entry: Entry, snapshot: SubagentSnapshot): void {
    entry.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  private requireEntry(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown subagent ${id}.`);
    return entry;
  }

  /** Drops the oldest settled entries once the tracked set outgrows its bound. */
  private prune(): void {
    if (this.entries.size <= this.maxTracked) return;
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= this.maxTracked) break;
      if (entry.snapshot.status === "running") continue;
      entry.session?.dispose();
      this.entries.delete(id);
      this.delivery.consume(id);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
