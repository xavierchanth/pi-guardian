/** Async, terminal-independent keyset source used by large dashboard domains. */
export interface RowPage<Row> {
  readonly rows: readonly Row[];
  readonly next?: string;
  readonly previous?: string;
}

export interface RowSource<Row> {
  load(input: {
    readonly after?: string;
    readonly before?: string;
    readonly limit: number;
  }): Promise<RowPage<Row>>;
}

export interface HydratedRows<Row> {
  readonly rows: readonly Row[];
  readonly loading: boolean;
  readonly error?: string;
}

/**
 * Maintains a bounded cache around a keyset page. A monotonically increasing
 * sequence makes late completions harmless (including completions after reset).
 */
export class KeysetHydrator<Row> {
  private readonly source: RowSource<Row>;
  private readonly pageSize: number;
  private readonly maxRows: number;
  private sequence = 0;
  private value: HydratedRows<Row> = { rows: [], loading: false };
  private next: string | undefined;
  private previous: string | undefined;
  private disposed = false;
  private readonly listeners = new Set<() => void>();

  constructor(source: RowSource<Row>, pageSize = 40, maxRows = pageSize * 3) {
    this.source = source;
    this.pageSize = pageSize;
    this.maxRows = maxRows;
  }

  snapshot(): HydratedRows<Row> {
    return this.value;
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(): void {
    if (this.disposed) return;
    this.sequence++;
    this.next = undefined;
    this.previous = undefined;
    this.value = { rows: [], loading: false };
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sequence++;
    this.listeners.clear();
  }

  async hydrate(): Promise<boolean> {
    return this.request({}, "replace");
  }

  async prefetchNext(): Promise<boolean> {
    if (!this.next) return false;
    return this.request({ after: this.next }, "append");
  }

  async prefetchPrevious(): Promise<boolean> {
    if (!this.previous) return false;
    return this.request({ before: this.previous }, "prepend");
  }

  private async request(
    cursor: { after?: string; before?: string },
    mode: "replace" | "append" | "prepend",
  ): Promise<boolean> {
    if (this.disposed) return false;
    const sequence = ++this.sequence;
    this.value = { ...this.value, loading: true, error: undefined };
    this.emit();
    try {
      const page = await this.source.load({ ...cursor, limit: Math.max(1, this.pageSize) });
      if (sequence !== this.sequence) return false;
      const combined =
        mode === "replace"
          ? page.rows
          : mode === "append"
            ? [...this.value.rows, ...page.rows]
            : [...page.rows, ...this.value.rows];
      const limit = Math.max(this.pageSize, this.maxRows);
      this.value = {
        rows: mode === "prepend" ? combined.slice(0, limit) : combined.slice(-limit),
        loading: false,
      };
      this.next = page.next;
      this.previous = page.previous;
      this.emit();
      return true;
    } catch (error) {
      if (sequence !== this.sequence) return false;
      this.value = {
        ...this.value,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      };
      this.emit();
      return false;
    }
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }
}
