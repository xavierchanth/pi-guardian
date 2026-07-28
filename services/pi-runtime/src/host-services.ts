import { randomUUID } from "node:crypto";
import type { RuntimeProtocolError } from "@pi-tai/runtime-protocol";
import type { RuntimeEventInput } from "./runtime-port.ts";

export interface HostServicePort {
  request<T = unknown>(method: string, params: unknown): Promise<T>;
}

export class RuntimeHostServices implements HostServicePort {
  private readonly emit: (event: RuntimeEventInput) => void;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  constructor(emit: (event: RuntimeEventInput) => void) { this.emit = emit; }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(method)) return Promise.reject(new Error(`Invalid Host service method: ${method}`));
    const requestId = `host-service-${randomUUID()}`;
    const promise = new Promise<unknown>((resolve, reject) => this.pending.set(requestId, { resolve, reject }));
    this.emit({ event: "host.service_request", data: { requestId, method, params } });
    return promise as Promise<T>;
  }

  resolve(input: { requestId: string; ok: boolean; result?: unknown; error?: RuntimeProtocolError }): void {
    const pending = this.pending.get(input.requestId);
    if (!pending) throw new Error(`Unknown Host service request: ${input.requestId}`);
    this.pending.delete(input.requestId);
    if (input.ok) pending.resolve(input.result);
    else pending.reject(new HostServiceError(input.error));
  }

  failAll(reason: string): void {
    for (const pending of this.pending.values()) pending.reject(new Error(reason));
    this.pending.clear();
  }
}

export class HostServiceError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;
  constructor(error?: RuntimeProtocolError) {
    super(error?.message ?? "Host service request failed.");
    this.name = "HostServiceError";
    this.code = error?.code ?? "host_service_failed";
    this.retryable = error?.retryable ?? false;
    this.details = error?.details;
  }
}
