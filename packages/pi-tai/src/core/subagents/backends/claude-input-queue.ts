import { randomUUID } from "node:crypto";
import { SendNotDeliveredError } from "../backend.ts";

export interface ClaudeUserMessage {
  readonly type: "user";
  readonly message: { readonly role: "user"; readonly content: string };
  readonly parent_tool_use_id: null;
  readonly session_id: string;
  readonly uuid: string;
}

/** Single-consumer bounded FIFO used by Claude's streaming-input mode. */
export class ClaudeInputQueue implements AsyncIterable<ClaudeUserMessage> {
  static readonly maxMessages = 8;
  static readonly maxBytes = 64 * 1024;
  private readonly buffer: ClaudeUserMessage[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<ClaudeUserMessage>) => void;
    reject: (error: Error) => void;
  }> = [];
  private bytes = 0;
  private closed = false;
  private yieldedUuid?: string;

  get lastYieldedUuid(): string | undefined { return this.yieldedUuid; }
  get pending(): number { return this.buffer.length; }
  get pendingBytes(): number { return this.bytes; }

  push(content: string): string {
    if (this.closed) throw new SendNotDeliveredError("Claude input is closed.", "closed");
    const bytes = Buffer.byteLength(content, "utf8");
    if (this.buffer.length >= ClaudeInputQueue.maxMessages || this.bytes + bytes > ClaudeInputQueue.maxBytes)
      throw new SendNotDeliveredError("Claude input queue is saturated.", "saturated");
    const uuid = randomUUID();
    const message: ClaudeUserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: "",
      uuid,
    };
    const waiter = this.waiters.shift();
    if (waiter) {
      this.yieldedUuid = uuid;
      waiter.resolve({ value: message, done: false });
    }
    else { this.buffer.push(message); this.bytes += bytes; }
    return uuid;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  failAll(reason: "closed" | "precondition" = "closed"): void {
    this.closed = true;
    this.buffer.length = 0;
    this.bytes = 0;
    const error = new SendNotDeliveredError("Claude input was not delivered.", reason);
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeUserMessage> {
    return {
      next: () => {
        const value = this.buffer.shift();
        if (value) {
          this.yieldedUuid = value.uuid;
          this.bytes -= Buffer.byteLength(value.message.content, "utf8");
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}
