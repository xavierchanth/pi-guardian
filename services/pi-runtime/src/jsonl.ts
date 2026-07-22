import type { Writable } from "node:stream";
import {
  validateRuntimeEvent,
  validateRuntimeResponse,
  type RuntimeEvent,
  type RuntimeResponse,
} from "@pi-tai/runtime-protocol";

export const MAX_INPUT_LINE_BYTES = 1024 * 1024;

export interface JsonlReaderHandlers {
  onValue(value: unknown): void | Promise<void>;
  onMalformed(reason: string): void | Promise<void>;
}

export class JsonlReader {
  private buffer = Buffer.alloc(0);
  private queue = Promise.resolve();
  private ended = false;
  private readonly handlers: JsonlReaderHandlers;

  constructor(handlers: JsonlReaderHandlers) {
    this.handlers = handlers;
  }

  push(chunk: Buffer | string): void {
    if (this.ended) throw new Error("Cannot push after JSONL reader end.");
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.buffer = Buffer.concat([this.buffer, bytes]);
    this.drain();
    if (this.buffer.length > MAX_INPUT_LINE_BYTES) {
      this.buffer = Buffer.alloc(0);
      this.enqueueMalformed("Input line exceeds maximum size.");
    }
  }

  end(): Promise<void> {
    this.ended = true;
    if (this.buffer.length > 0) {
      this.buffer = Buffer.alloc(0);
      this.enqueueMalformed("Input ended before newline terminator.");
    }
    return this.queue;
  }

  private drain(): void {
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      let line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length > MAX_INPUT_LINE_BYTES) {
        this.enqueueMalformed("Input line exceeds maximum size.");
        continue;
      }
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.length === 0) {
        this.enqueueMalformed("Input line is empty.");
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(line.toString("utf8"));
      } catch {
        this.enqueueMalformed("Input line is not valid JSON.");
        continue;
      }
      this.queue = this.queue.then(() => this.handlers.onValue(value));
    }
  }

  private enqueueMalformed(reason: string): void {
    this.queue = this.queue.then(() => this.handlers.onMalformed(reason));
  }
}

export class JsonlWriter {
  private queue = Promise.resolve();
  private readonly writable: Writable | { write(chunk: string): boolean; once(event: "drain", listener: () => void): unknown };

  constructor(writable: Writable | { write(chunk: string): boolean; once(event: "drain", listener: () => void): unknown }) {
    this.writable = writable;
  }

  writeResponse(response: RuntimeResponse): Promise<void> {
    return this.write(validateRuntimeResponse(response));
  }

  writeEvent(event: RuntimeEvent): Promise<void> {
    return this.write(validateRuntimeEvent(event));
  }

  flush(): Promise<void> {
    return this.queue;
  }

  private write(frame: RuntimeResponse | RuntimeEvent): Promise<void> {
    const serialized = `${JSON.stringify(frame)}\n`;
    this.queue = this.queue.then(() => new Promise<void>((resolve) => {
      if (this.writable.write(serialized)) {
        resolve();
      } else {
        this.writable.once("drain", resolve);
      }
    }));
    return this.queue;
  }
}
