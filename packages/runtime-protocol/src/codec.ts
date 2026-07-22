import { z } from "zod";
import type { RuntimeCommand, RuntimeEvent, RuntimeProtocolError, RuntimeResponse } from "./generated.ts";
import { isRuntimeMethod, runtimeMethodRegistry, type RuntimeMethod, type RuntimeMethodParams } from "./registry.ts";
import {
  CURRENT_RUNTIME_PROTOCOL_VERSION,
  RuntimeCommandSchema,
  RuntimeEventSchema,
  RuntimeResponseSchema,
} from "./schemas.ts";

export class RuntimeDecodeError extends Error {
  readonly code: "invalid_envelope" | "invalid_params";
  readonly details: Array<{ path: string; code: string }>;

  constructor(
    code: RuntimeDecodeError["code"],
    message: string,
    issues: readonly z.core.$ZodIssue[],
  ) {
    super(message);
    this.name = "RuntimeDecodeError";
    this.code = code;
    this.details = issues.slice(0, 16).map((issue) => ({
      path: issue.path.map(String).join("."),
      code: issue.code,
    }));
  }

  toProtocolError(): RuntimeProtocolError {
    return {
      code: this.code,
      message: this.message,
      retryable: false,
      details: this.details,
    };
  }
}

export function decodeRuntimeCommand(value: unknown): RuntimeCommand {
  const parsed = RuntimeCommandSchema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeDecodeError("invalid_envelope", "Runtime command envelope is invalid.", parsed.error.issues);
  }
  return parsed.data;
}

export function decodeMethodParams<M extends RuntimeMethod>(
  method: M,
  value: unknown,
): RuntimeMethodParams<M>;
export function decodeMethodParams(method: string, value: unknown): unknown;
export function decodeMethodParams(method: string, value: unknown): unknown {
  if (!isRuntimeMethod(method)) return value;
  const parsed = runtimeMethodRegistry[method].params.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeDecodeError("invalid_params", `Parameters for ${method} are invalid.`, parsed.error.issues);
  }
  return parsed.data;
}

export function validateMethodResult<M extends RuntimeMethod>(
  method: M,
  value: unknown,
): unknown {
  const parsed = runtimeMethodRegistry[method].result.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeDecodeError("invalid_envelope", `Result for ${method} is invalid.`, parsed.error.issues);
  }
  return parsed.data;
}

export function validateRuntimeResponse(value: unknown): RuntimeResponse {
  const parsed = RuntimeResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeDecodeError("invalid_envelope", "Runtime response envelope is invalid.", parsed.error.issues);
  }
  return parsed.data;
}

export function validateRuntimeEvent(value: unknown): RuntimeEvent {
  const parsed = RuntimeEventSchema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeDecodeError("invalid_envelope", "Runtime event envelope is invalid.", parsed.error.issues);
  }
  return parsed.data;
}

export function successResponse(id: string, result: unknown): RuntimeResponse {
  return validateRuntimeResponse({
    protocolVersion: CURRENT_RUNTIME_PROTOCOL_VERSION,
    kind: "response",
    id,
    ok: true,
    result,
  });
}

export function errorResponse(id: string, error: RuntimeProtocolError): RuntimeResponse {
  return validateRuntimeResponse({
    protocolVersion: CURRENT_RUNTIME_PROTOCOL_VERSION,
    kind: "response",
    id,
    ok: false,
    error,
  });
}
