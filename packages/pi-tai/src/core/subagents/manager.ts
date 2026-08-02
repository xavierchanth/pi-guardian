import { randomUUID } from "node:crypto";
import type { DurableRecordStore } from "../durable/port.ts";
import {
  type BackendRegistry,
  type SendMode,
  SendNotDeliveredError,
  type SubagentBackend,
  type SubagentSession,
} from "./backend.ts";
import {
  applyEvent,
  type BackendName,
  type CapabilityName,
  emptySnapshot,
  type SpawnTask,
  type SubagentEvent,
  type SubagentSnapshot,
} from "./domain.ts";
import { foldLifecycle, type SubagentLifecycleStore } from "./lifecycle.ts";
import { InMemoryRecordStore } from "./records.ts";
import { DeferredResultDelivery } from "./result-delivery.ts";

export const MAX_RUNNING_SUBAGENTS = 32;
export const MAX_UNARCHIVED_RECORDS = 128;
export const MAX_DURABLE_RECORDS = 4096;
export const MAX_RESIDENT_SUBAGENTS = 256;
/** @deprecated Use MAX_RESIDENT_SUBAGENTS. */
export const MAX_TRACKED_SUBAGENTS = MAX_RESIDENT_SUBAGENTS;

export type CapacityKind = "running" | "unarchived" | "durable";
export class SubagentCapacityError extends Error {
  readonly kind: CapacityKind;
  constructor(kind: CapacityKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = "SubagentCapacityError";
  }
}

export interface CapacityReport {
  readonly running: number;
  readonly maxRunning: number;
  readonly unarchived: number;
  readonly maxUnarchived: number;
  readonly archived: number;
  readonly inherited: number;
  readonly durable: number;
  readonly maxDurable: number;
  readonly resident: number;
  readonly maxResident: number;
  readonly archiveEnforced: boolean;
  readonly orphanReservations: number;
}

export interface SpawnRequest {
  readonly backend: BackendName;
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly cwd: string;
  readonly title: string;
  readonly workspaceId?: string;
  readonly capability?: CapabilityName;
  readonly model?: string;
  readonly provider?: string;
  readonly effort?: string;
  readonly tools?: readonly string[];
}

export interface WaitResult {
  readonly settled: readonly SubagentSnapshot[];
  readonly pending: readonly SubagentSnapshot[];
  readonly reason: "settled" | "user-interrupted";
}

export interface SubagentManagerOptions {
  readonly registry: BackendRegistry;
  readonly maxRunning?: number;
  readonly maxUnarchived?: number;
  readonly maxDurable?: number;
  readonly maxResident?: number;
  /** @deprecated Use maxResident. */
  readonly maxTracked?: number;
  readonly rootSessionId?: string;
  readonly now?: () => string;
  /** Durable authority injection seam; C1 defaults to the in-memory adapter. */
  readonly records?: DurableRecordStore;
  /**
   * Called once per subagent when it reaches a terminal state, before the result
   * is deferred. The workspace layer hooks in here to reclaim or flag isolation
   * on failure, which is what keeps a crashed spawn from leaking a workspace.
   */
  readonly onSettled?: (snapshot: SubagentSnapshot) => void | Promise<void>;
  readonly lifecycleStore?: SubagentLifecycleStore;
  readonly requireLifecycleStore?: boolean;
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
  /** Branch generation captured for this run; navigation must not change it. */
  generation: number;
  readonly sequence: number;
  /** Serializes messages without blocking messages to other children. */
  sendChain: Promise<void>;
  /** Identity of the currently pumped run. */
  runToken: object;
  /** Permanent tombstone: queued work must never reopen this entry. */
  closed: boolean;
  /** Historical records have no spawn task or live continuation handle. */
  restored: boolean;
  /** Workspace custody is independent of the historical workspace identifier. */
  custodyResolved: boolean;
}

export type RequestedSendMode = SendMode | "auto";
export interface SendReceipt {
  readonly operation: SendMode;
  readonly settlementRace: boolean;
}

/**
 * Owns the lifecycle of every subagent: reservation, event folding, settlement,
 * and deferred result handoff. Backends supply behaviour; this class supplies
 * the bookkeeping that used to be spread across the tool handlers.
 */
export class SubagentManager {
  private readonly registry: BackendRegistry;
  private readonly maxRunning: number;
  private readonly maxUnarchived: number;
  private readonly maxDurable: number;
  private readonly maxResident: number;
  private readonly rootSessionId?: string;
  private readonly records: DurableRecordStore;
  /** Spawn intents reserved before their first await but not yet indexed. */
  private pendingDurable = 0;
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
  private readonly reservations = new Set<object>();
  private sequence = 0;
  private lifecycleStore?: SubagentLifecycleStore;
  private generation = 1;
  private readonly persistenceErrors: string[] = [];
  private readonly requireLifecycleStore: boolean;

  constructor(options: SubagentManagerOptions) {
    this.registry = options.registry;
    this.maxRunning = options.maxRunning ?? MAX_RUNNING_SUBAGENTS;
    this.maxUnarchived = options.maxUnarchived ?? MAX_UNARCHIVED_RECORDS;
    this.maxDurable = options.maxDurable ?? MAX_DURABLE_RECORDS;
    this.maxResident = options.maxResident ?? options.maxTracked ?? MAX_RESIDENT_SUBAGENTS;
    this.rootSessionId = options.rootSessionId;
    this.records = options.records ?? new InMemoryRecordStore(options.rootSessionId);
    this.clock = options.now ?? (() => new Date().toISOString());
    if (options.onSettled) this.onSettled = options.onSettled;
    if (options.lifecycleStore) this.lifecycleStore = options.lifecycleStore;
    this.requireLifecycleStore = options.requireLifecycleStore ?? false;
  }

  /** Re-folds the active branch. Live handles are carried forward on tree moves. */
  async attachLifecycleStore(store: SubagentLifecycleStore): Promise<void> {
    this.lifecycleStore = store;
    const folded = foldLifecycle(await store.load());
    this.sequence = Math.max(this.sequence, folded.maxSequence);
    this.records.ingest(folded.records.values());
    for (const record of folded.records.values()) {
      if ([...this.entries.values()].some((entry) => entry.snapshot.durableId === record.durableId))
        continue;
      // Display IDs are branch-local. Never let a historical sibling replace a
      // live slot (and its wait promise/session) merely because their labels match.
      if (this.entries.has(record.displayId)) continue;
      // Historical records are observational only. An unproved prior run is never called running.
      const disposition = record.disposition === "done" ? "done" : "error";
      const backend = this.registry.get(record.backend);
      if (!backend) continue;
      const resolveSettled: (snapshot: SubagentSnapshot) => void = () => {};
      const snapshot = {
        ...emptySnapshot({
          id: record.displayId,
          durableId: record.durableId,
          backend: record.backend,
          title: record.title,
          cwd: record.cwd,
          createdAt: record.createdAt,
        }),
        status: disposition,
        ...(disposition === "error"
          ? {
              errorText:
                record.disposition === "running"
                  ? "Interrupted by session reload."
                  : record.disposition === "interrupted"
                    ? "Run was interrupted."
                    : record.disposition === "failed"
                      ? "Run failed."
                      : "Spawn did not reach a durable running state.",
            }
          : {}),
        settledAt: record.updatedAt,
      } as SubagentSnapshot;
      const settled = Promise.resolve(snapshot);
      this.entries.set(record.displayId, {
        snapshot,
        backend,
        task: undefined as unknown as SpawnTask,
        settled,
        resolveSettled,
        abort: new AbortController(),
        generation: record.generation,
        sequence: record.sequence,
        sendChain: Promise.resolve(),
        runToken: {},
        closed: false,
        restored: true,
        custodyResolved: true,
      });
    }
    this.generation += 1;
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

  capacity(): CapacityReport {
    const counts = this.records.counts();
    return {
      running: this.reserved,
      maxRunning: this.maxRunning,
      unarchived: counts.unarchived,
      maxUnarchived: this.maxUnarchived,
      archived: counts.archived,
      inherited: counts.inherited,
      durable: counts.total,
      maxDurable: this.maxDurable,
      resident: this.entries.size,
      maxResident: this.maxResident,
      archiveEnforced: false,
      orphanReservations: 0,
    };
  }

  /** Advisory only: spawn performs the same check before its reservation. */
  assertAdmission(): void {
    if (this.reserved >= this.maxRunning)
      throw new SubagentCapacityError(
        "running",
        `At most ${this.maxRunning} subagents may run at once (${this.reserved} running); wait for one to finish, or abort one from /subagents.`,
      );
    if (this.records.counts().total + this.pendingDurable >= this.maxDurable)
      throw new SubagentCapacityError(
        "durable",
        `This session has reached its durable subagent record ceiling (${this.maxDurable}). Start a new session to continue delegating. A future /cleanup may release separately retained records, but cannot remove immutable subagent slots already written into the Pi transcript. Existing records, reports, and workspaces are untouched.`,
      );
  }

  /** Bounded diagnostics for optional lifecycle writes that failed after spawn. */
  get lifecyclePersistenceErrors(): readonly string[] {
    return this.persistenceErrors;
  }

  async spawn(request: SpawnRequest): Promise<SubagentSnapshot> {
    this.assertAdmission();
    const runToken = {};
    this.reserve(runToken);
    this.pendingDurable += 1;
    let durableCommitted = false;
    const id = `sa-${++this.sequence}`;
    const durableId = randomUUID();
    const generation = this.generation;
    try {
      if (!this.lifecycleStore && this.requireLifecycleStore)
        throw new Error(
          "Subagent lifecycle persistence is unavailable; refusing to start an unowned child.",
        );
      await this.lifecycleStore?.append({
        version: 2,
        type: "spawn_intent",
        durableId,
        displayId: id,
        sequence: this.sequence,
        generation,
        backend: request.backend,
        title: request.title,
        backendConfig: {
          ...(request.model ? { model: request.model } : {}),
          ...(request.provider ? { provider: request.provider } : {}),
          ...(request.effort ? { effort: request.effort } : {}),
          ...(request.tools ? { tools: request.tools } : {}),
        },
        workspace: { cwd: request.cwd, ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}) },
        ...(request.capability ? { capability: request.capability } : {}),
        charterRef: { kind: "manager_task", value: durableId },
        ...(this.rootSessionId ? { rootSessionId: this.rootSessionId } : {}),
        at: this.clock(),
      });
      const createdAt = this.clock();
      this.records.note(
        {
          durableId,
          displayId: id,
          sequence: this.sequence,
          ...(this.rootSessionId ? { rootSessionId: this.rootSessionId } : {}),
          disposition: "intent",
          updatedAt: createdAt,
        },
        true,
      );
      durableCommitted = true;
      this.pendingDurable -= 1;
      const backend = await this.registry.require(request.backend);
      const abort = new AbortController();
      let resolveSettled: (snapshot: SubagentSnapshot) => void = () => {};
      const settled = new Promise<SubagentSnapshot>((resolve) => {
        resolveSettled = resolve;
      });
      const entry: Entry = {
        snapshot: emptySnapshot({
          id,
          durableId,
          backend: request.backend,
          title: request.title,
          cwd: request.cwd,
          ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
          ...(request.capability ? { capability: request.capability } : {}),
          createdAt,
        }),
        settled,
        resolveSettled,
        abort,
        backend,
        task: undefined as unknown as SpawnTask,
        generation,
        sequence: this.sequence,
        sendChain: Promise.resolve(),
        runToken,
        closed: false,
        restored: false,
        custodyResolved: request.workspaceId === undefined,
      };
      this.entries.set(id, entry);
      this.prune();

      const task: SpawnTask = {
        id,
        durableId,
        prompt: request.prompt,
        systemPrompt: request.systemPrompt,
        cwd: request.cwd,
        title: request.title,
        ...(request.capability ? { capability: request.capability } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...(request.provider ? { provider: request.provider } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
        ...(request.tools ? { tools: request.tools } : {}),
        signal: abort.signal,
      };
      entry.task = task;
      try {
        // Running is durable before the backend receives control.
        await this.lifecycleStore?.append({
          version: 2,
          type: "running",
          durableId,
          generation: entry.generation,
          at: this.clock(),
        });
        entry.session = await backend.spawn(task);
        this.watchResumeHandle(entry, entry.session);
      } catch (error) {
        this.finish(entry, { type: "backend_error", message: describe(error) }, entry.runToken);
        throw error;
      }
      void this.pump(entry, entry.session, entry.runToken, entry.session.events);
      return entry.snapshot;
    } catch (error) {
      // Once an entry exists, finish() owns release of the running reservation.
      if (!this.entries.has(id)) this.release(runToken);
      if (!durableCommitted) this.pendingDurable = Math.max(0, this.pendingDurable - 1);
      throw error;
    }
  }

  /** Waits until any requested subagent settles and atomically collects all
   * requested terminal snapshots visible then. Foreground input can release
   * the wait without cancelling children, while tool cancellation still rejects.
   */
  async wait(
    ids: readonly string[],
    signal?: AbortSignal,
    interruption?: AbortSignal,
  ): Promise<WaitResult> {
    const unique = [...new Set(ids)];
    const missing = unique.filter((id) => !this.entries.has(id));
    if (missing.length) throw new Error(`Unknown subagent(s): ${missing.join(", ")}.`);

    if (signal?.aborted) throw new Error("Wait was cancelled.");

    const collect = (reason: WaitResult["reason"]): WaitResult => {
      const snapshots = unique.map((id) => this.entries.get(id)!.snapshot);
      const settled = snapshots.filter((snapshot) => snapshot.status !== "running");
      const pending = snapshots.filter((snapshot) => snapshot.status === "running");
      // No await is permitted between this status snapshot and consumption.
      for (const snapshot of settled) {
        this.delivery.consume(snapshot.id);
        const entry = this.entries.get(snapshot.id);
        if (entry?.snapshot.deliveryPending)
          this.update(entry, { ...entry.snapshot, deliveryPending: false });
      }
      return {
        settled: settled.map((snapshot) => this.entries.get(snapshot.id)!.snapshot),
        pending,
        reason,
      };
    };
    if (interruption?.aborted) return collect("user-interrupted");
    if (unique.some((id) => this.entries.get(id)!.snapshot.status !== "running"))
      return collect("settled");

    let onCancel: (() => void) | undefined;
    let onInterrupt: (() => void) | undefined;
    const cancelled =
      signal &&
      new Promise<never>((_, reject) => {
        onCancel = () => reject(new Error("Wait was cancelled."));
        signal.addEventListener("abort", onCancel, { once: true });
      });
    const interrupted =
      interruption &&
      new Promise<"user-interrupted">((resolve) => {
        onInterrupt = () => resolve("user-interrupted");
        interruption.addEventListener("abort", onInterrupt, { once: true });
      });
    try {
      const firstSettlement = Promise.race(unique.map((id) => this.entries.get(id)!.settled)).then(
        () => "settled" as const,
      );
      const outcome = await Promise.race([
        firstSettlement,
        ...(cancelled ? [cancelled] : []),
        ...(interrupted ? [interrupted] : []),
      ]);
      return collect(outcome);
    } finally {
      if (signal && onCancel) signal.removeEventListener("abort", onCancel);
      if (interruption && onInterrupt) interruption.removeEventListener("abort", onInterrupt);
    }
  }

  /**
   * Sends a message to a subagent.
   *
   * A running subagent is steered in place. A settled one is resumed — a new run
   * on the same conversation — when its harness supports that, which is how a
   * one-shot subagent becomes a thinking partner without holding a process open
   * between turns.
   */
  async send(id: string, text: string, mode: RequestedSendMode = "auto"): Promise<SendReceipt> {
    const entry = this.requireEntry(id);
    let resolve!: (value: SendReceipt) => void;
    let reject!: (reason: unknown) => void;
    const result = new Promise<SendReceipt>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    entry.sendChain = entry.sendChain
      .catch(() => {})
      .then(async () => {
        try {
          resolve(await this.dispatchSend(entry, text, mode));
        } catch (error) {
          reject(error);
        }
      });
    return result;
  }

  private async dispatchSend(
    entry: Entry,
    text: string,
    requested: RequestedSendMode,
  ): Promise<SendReceipt> {
    const id = entry.snapshot.id;
    if (entry.closed) throw new Error(`Subagent ${id} is closed and cannot accept input.`);
    if (entry.restored)
      throw new Error(
        `Subagent ${id} was restored as a historical record without a live task or continuation handle.`,
      );
    if (entry.snapshot.status === "running") {
      const liveInput = entry.session?.liveInput ?? entry.backend.capabilities.liveInput;
      const operation =
        requested === "auto"
          ? liveInput.includes("steer")
            ? "steer"
            : liveInput.includes("followUp")
              ? "followUp"
              : undefined
          : requested;
      if (operation === "continue")
        throw new Error(
          `Subagent ${id} is still running; continue is only valid after it settles.`,
        );
      if (!operation || !liveInput.includes(operation))
        throw new Error(
          `Subagent ${id} is running, but the ${entry.snapshot.backend} backend does not support ${operation ?? "live input"}.`,
        );
      if (!entry.session) throw new Error(`Subagent ${id} has no live session.`);
      try {
        await entry.session.send(text, operation);
        return { operation, settlementRace: false };
      } catch (error) {
        if (!(error instanceof SendNotDeliveredError)) throw error;
        if (error.reason !== "settled") throw error;
        if (requested !== "auto")
          throw new Error(
            `Subagent ${id} settled before ${operation} could be delivered; it was not continued.`,
          );
        await this.continueSettled(entry, text, true);
        return { operation: "continue", settlementRace: true };
      }
    }
    if (requested === "steer" || requested === "followUp")
      throw new Error(
        `Subagent ${id} settled before ${requested} could be delivered; it was not continued.`,
      );
    await this.continueSettled(entry, text);
    return { operation: "continue", settlementRace: false };
  }

  private async continueSettled(entry: Entry, text: string, settlementRace = false): Promise<void> {
    // A settled refusal proves the old run no longer needs its slot even while
    // its terminal frame remains queued. Release is idempotent across races.
    if (settlementRace) this.release(entry.runToken);
    const how = entry.backend.capabilities.settledContinuation;
    if (how === "in-place" && entry.session?.continueInPlace) {
      await this.continueInPlace(entry, text);
      return;
    }
    const resumeToken = entry.session?.resumeToken;
    if (how === "respawn" && resumeToken) {
      await this.resume(entry, text, resumeToken);
      return;
    }
    throw new Error(
      `Subagent ${entry.snapshot.id} has finished and the ${entry.snapshot.backend} harness cannot continue its conversation; spawn a new subagent instead.`,
    );
  }

  private async continueInPlace(entry: Entry, text: string): Promise<void> {
    if (entry.closed || !entry.session?.continueInPlace)
      throw new Error(`Subagent ${entry.snapshot.id} has no retained live conversation.`);
    if (this.reserved >= this.maxRunning)
      throw new SubagentCapacityError(
        "running",
        `At most ${this.maxRunning} subagents may run at once (${this.reserved} running); wait for one to finish, or abort one from /subagents.`,
      );
    const runToken = {};
    this.reserve(runToken);
    const previous = entry.snapshot;
    try {
      // Persist the reservation before exposing it. Unlike a respawn, the
      // retained Pi handle can begin producing events synchronously, so all
      // manager state and the single-writer token must be installed first.
      await this.lifecycleStore?.append({
        version: 2,
        type: "generation_advanced",
        durableId: entry.snapshot.durableId,
        previousGeneration: entry.generation,
        generation: entry.generation + 1,
        at: this.clock(),
      });
      const nextGeneration = entry.generation + 1;
      await this.lifecycleStore?.append({ version: 2, type: "running", durableId: entry.snapshot.durableId, generation: nextGeneration, at: this.clock() });
      entry.generation = nextGeneration;
      if (entry.closed) throw new Error(`Subagent ${entry.snapshot.id} closed while continuing.`);
      let resolveSettled: (snapshot: SubagentSnapshot) => void = () => {};
      const settled = new Promise<SubagentSnapshot>((resolve) => {
        resolveSettled = resolve;
      });
      Object.assign(entry, { settled, resolveSettled, runToken });
      this.delivery.consume(entry.snapshot.id);
      this.update(entry, {
        ...entry.snapshot,
        status: "running",
        latestText: "",
        turns: 0,
        liveTools: [],
        deliveryPending: false,
      });
      const accepted = entry.session.continueInPlace(text);
      // Attach the consumer before yielding to completion. EventChannel buffers
      // synchronous run_started frames, while runToken prevents an old pump
      // from settling this new generation.
      void this.pump(entry, entry.session, runToken, entry.session.events);
      await accepted;
    } catch (error) {
      if (entry.snapshot.status === "running") this.update(entry, previous);
      this.release(runToken);
      throw error;
    }
  }

  /** Starts a follow-up run in place, reusing the entry so the id stays stable. */
  private async resume(entry: Entry, text: string, resumeToken: string): Promise<void> {
    if (entry.closed) throw new Error(`Subagent ${entry.snapshot.id} is closed and cannot resume.`);
    if (this.reserved >= this.maxRunning)
      throw new SubagentCapacityError(
        "running",
        `At most ${this.maxRunning} subagents may run at once (${this.reserved} running); wait for one to finish, or abort one from /subagents.`,
      );
    const runToken = {};
    this.reserve(runToken);
    const task: SpawnTask = { ...entry.task, prompt: text, resumeToken };
    let session: SubagentSession | undefined;
    try {
      session = await entry.backend.spawn(task);
      // Advance exactly once before exposing the successor generation.
      await this.lifecycleStore?.append({ version: 2, type: "generation_advanced", durableId: entry.snapshot.durableId, previousGeneration: entry.generation, generation: entry.generation + 1, at: this.clock() });
      const nextGeneration = entry.generation + 1;
      await this.lifecycleStore?.append({ version: 2, type: "running", durableId: entry.snapshot.durableId, generation: nextGeneration, at: this.clock() });
      entry.generation = nextGeneration;
      if (entry.closed) throw new Error(`Subagent ${entry.snapshot.id} closed while resuming.`);
    } catch (error) {
      session?.dispose();
      this.release(runToken);
      throw error;
    }
    entry.task = task;
    entry.session?.dispose();
    entry.session = session;
    this.watchResumeHandle(entry, session);
    // Reopen the entry so `wait` and result delivery work exactly as on a first run.
    let resolveSettled: (snapshot: SubagentSnapshot) => void = () => {};
    const settled = new Promise<SubagentSnapshot>((resolve) => {
      resolveSettled = resolve;
    });
    Object.assign(entry, { settled, resolveSettled, runToken });
    this.delivery.consume(entry.snapshot.id);
    this.update(entry, {
      ...entry.snapshot,
      status: "running",
      latestText: "",
      liveTools: [],
      deliveryPending: false,
    });
    void this.pump(entry, session, runToken, session.events);
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
      // Settled entries may still be continued; only an active cancellation
      // tombstones the entry against future sends.
      entry.closed = true;
      entry.abort.abort();
      try {
        await entry.session?.interrupt();
      } catch {
        // A backend that cannot interrupt cleanly still settles below.
      }
      this.finish(entry, { type: "run_settled", outcome: "interrupted" }, entry.runToken);
      cancelled.push(entry.snapshot);
    }
    return cancelled;
  }

  /** Cancels everything and releases backend resources. */
  async shutdown(): Promise<void> {
    const running = this.list()
      .filter((snapshot) => snapshot.status === "running")
      .map((snapshot) => snapshot.id);
    if (running.length) await this.cancel(running);
    for (const entry of this.entries.values()) {
      entry.closed = true;
      entry.session?.dispose();
    }
    this.entries.clear();
    this.delivery.clear();
    this.reservations.clear();
    this.reserved = 0;
  }

  private async pump(
    entry: Entry,
    session: SubagentSession,
    token: object,
    events: AsyncIterable<SubagentEvent>,
  ): Promise<void> {
    try {
      for await (const event of events) {
        if (entry.closed || entry.session !== session || entry.runToken !== token) return;
        if (event.type === "run_settled" || event.type === "backend_error") {
          this.finish(entry, event, token);
          return;
        }
        this.update(entry, applyEvent(entry.snapshot, event, this.clock()));
      }
      // The stream ended without a terminal event; treat that as a backend fault
      // rather than leaving the entry running forever.
      if (!entry.closed && entry.session === session && entry.snapshot.status === "running") {
        this.finish(
          entry,
          {
            type: "backend_error",
            message: "Backend closed the event stream without settling.",
          },
          token,
        );
      }
    } catch (error) {
      this.finish(entry, { type: "backend_error", message: describe(error) }, token);
    }
  }

  private reserve(token: object): void {
    this.reservations.add(token);
    this.reserved = this.reservations.size;
  }

  private release(token: object): void {
    this.reservations.delete(token);
    this.reserved = this.reservations.size;
  }

  private finish(entry: Entry, event: Parameters<typeof applyEvent>[1], token: object): void {
    if (entry.runToken !== token || entry.snapshot.status !== "running") {
      this.release(token);
      return;
    }
    this.update(entry, applyEvent(entry.snapshot, event, this.clock()));
    const disposition =
      event.type === "run_settled" && event.outcome === "completed"
        ? "done"
        : event.type === "run_settled" && event.outcome === "interrupted"
          ? "interrupted"
          : "failed";
    void this.lifecycleStore
      ?.append({
        version: 2,
        type: "terminal",
        durableId: entry.snapshot.durableId,
        generation: entry.generation,
        disposition,
        at: this.clock(),
      })
      .catch((error) => this.recordPersistenceError(error));
    this.release(token);
    const snapshot = entry.snapshot;
    // Defer before resolving: a `wait` that is already pending must be able to
    // consume this result, which it can only do once it exists.
    this.delivery.defer({
      id: snapshot.id,
      text: snapshot.finalText || snapshot.errorText || "",
    });
    this.update(entry, { ...entry.snapshot, deliveryPending: true });
    this.records.note(
      {
        ...(this.records.get(snapshot.durableId) ?? {
          durableId: snapshot.durableId,
          displayId: snapshot.id,
          sequence: entry.sequence,
          updatedAt: snapshot.createdAt,
        }),
        disposition,
        updatedAt: this.clock(),
      },
      true,
    );
    entry.resolveSettled(entry.snapshot);
    // The hook runs after settlement so a slow or broken workspace reclaim
    // cannot stall the parent's `wait`.
    void Promise.resolve(this.onSettled?.(snapshot)).catch(() => {});
  }

  private watchResumeHandle(entry: Entry, session: SubagentSession): void {
    const kind = entry.snapshot.backend === "pi" ? "pi_session_file" : entry.snapshot.backend === "claude" ? "claude_session" : "codex_thread";
    const persist = (value: string) => {
      if (!value) return;
      void this.lifecycleStore?.append({ version: 2, type: "resume_handle_discovered", durableId: entry.snapshot.durableId, generation: entry.generation, resumeHandle: { kind, value } as never, at: this.clock() }).catch((error) => this.recordPersistenceError(error));
    };
    if (session.onResumeHandle) session.onResumeHandle(persist);
    else if (session.sessionFile) persist(session.sessionFile);
    else if (session.resumeToken) persist(session.resumeToken);
  }

  private recordPersistenceError(error: unknown): void {
    this.persistenceErrors.push(describe(error));
    if (this.persistenceErrors.length > 16) this.persistenceErrors.shift();
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

  /** Marks managed workspace custody as merged, discarded, or safely reclaimed. */
  resolveCustody(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.custodyResolved = true;
    this.prune();
  }

  /** Drains deferred results and clears their presentation projection. */
  drainDelivery() {
    const results = this.delivery.drain();
    for (const result of results) {
      const entry = this.entries.get(result.id);
      if (entry?.snapshot.deliveryPending)
        this.update(entry, { ...entry.snapshot, deliveryPending: false });
    }
    return results;
  }

  /** Drops only safely delivered settled records; durable counts are unaffected. */
  private prune(): void {
    if (this.entries.size <= this.maxResident) return;
    const candidates = [...this.entries.entries()]
      .filter(
        ([, entry]) =>
          entry.snapshot.status !== "running" &&
          !this.delivery.isPending(entry.snapshot.id) &&
          !entry.snapshot.attention &&
          entry.custodyResolved,
      )
      .sort(([, a], [, b]) => {
        const rank = (entry: Entry): number => {
          if (this.records.get(entry.snapshot.durableId)?.archivedAt !== undefined) return 0;
          return entry.snapshot.status === "done" ? 1 : 2;
        };
        return (
          rank(a) - rank(b) ||
          (a.snapshot.settledAt ?? a.snapshot.createdAt).localeCompare(
            b.snapshot.settledAt ?? b.snapshot.createdAt,
          )
        );
      });
    for (const [id, entry] of candidates) {
      if (this.entries.size <= this.maxResident) break;
      entry.closed = true;
      entry.session?.dispose();
      this.entries.delete(id);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
