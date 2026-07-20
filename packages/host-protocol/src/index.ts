export const CURRENT_PROTOCOL_VERSION = 1;

export interface ProtocolRange {
  minVersion: number;
  maxVersion: number;
}

export interface ImplementationInfo {
  name: string;
  version: string;
}

export type ClientKind = "acp" | "diagnostic" | "desktop" | "mobile";

export interface ClientHello {
  protocol: ProtocolRange;
  implementation: ImplementationInfo;
  clientKind: ClientKind;
}

export interface HostHello {
  protocolVersion: number;
  implementation: ImplementationInfo;
  capabilities: string[];
}

export interface HostCommand<T = unknown> {
  protocolVersion: number;
  requestId: string;
  operationId: string;
  clientId: string;
  sessionId?: string;
  expectedRevision?: number;
  kind: string;
  payload: T;
}

export interface HostEvent<T = unknown> {
  protocolVersion: number;
  sessionId: string;
  sequence: number;
  revision: number;
  runtimeGeneration: number;
  timestamp: string;
  type: string;
  payload: T;
}

export interface HostProtocolError {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export class ProtocolDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolDecodeError";
  }
}

export class ProtocolNegotiationError extends Error {
  readonly client: ProtocolRange;
  readonly host: ProtocolRange;

  constructor(client: ProtocolRange, host: ProtocolRange) {
    super(
      `Incompatible protocol ranges: client ${client.minVersion}-${client.maxVersion}, host ${host.minVersion}-${host.maxVersion}`,
    );
    this.name = "ProtocolNegotiationError";
    this.client = client;
    this.host = host;
  }
}

export function currentProtocolRange(): ProtocolRange {
  return {
    minVersion: CURRENT_PROTOCOL_VERSION,
    maxVersion: CURRENT_PROTOCOL_VERSION,
  };
}

export function negotiateProtocol(
  client: ProtocolRange,
  host: ProtocolRange,
): number {
  const minimum = Math.max(client.minVersion, host.minVersion);
  const maximum = Math.min(client.maxVersion, host.maxVersion);
  if (minimum <= maximum) return maximum;
  throw new ProtocolNegotiationError(client, host);
}

export function parseClientHello(value: unknown): ClientHello {
  const input = record(value, "client hello");
  const clientKind = string(input.clientKind, "clientKind");
  if (!(["acp", "diagnostic", "desktop", "mobile"] as const).includes(clientKind as ClientKind)) {
    throw new ProtocolDecodeError(`Invalid clientKind: ${clientKind}`);
  }
  return {
    protocol: protocolRange(input.protocol),
    implementation: implementationInfo(input.implementation),
    clientKind: clientKind as ClientKind,
  };
}

export function parseHostHello(value: unknown): HostHello {
  const input = record(value, "host hello");
  if (!Array.isArray(input.capabilities) || input.capabilities.some((item) => typeof item !== "string")) {
    throw new ProtocolDecodeError("capabilities must be an array of strings");
  }
  return {
    protocolVersion: safeInteger(input.protocolVersion, "protocolVersion"),
    implementation: implementationInfo(input.implementation),
    capabilities: [...input.capabilities] as string[],
  };
}

export function parseHostCommand(value: unknown): HostCommand {
  const input = record(value, "host command");
  return {
    protocolVersion: safeInteger(input.protocolVersion, "protocolVersion"),
    requestId: string(input.requestId, "requestId"),
    operationId: string(input.operationId, "operationId"),
    clientId: string(input.clientId, "clientId"),
    ...(input.sessionId === undefined
      ? {}
      : { sessionId: string(input.sessionId, "sessionId") }),
    ...(input.expectedRevision === undefined
      ? {}
      : {
          expectedRevision: safeInteger(
            input.expectedRevision,
            "expectedRevision",
          ),
        }),
    kind: string(input.kind, "kind"),
    payload: input.payload,
  };
}

export function parseHostEvent(value: unknown): HostEvent {
  const input = record(value, "host event");
  return {
    protocolVersion: safeInteger(input.protocolVersion, "protocolVersion"),
    sessionId: string(input.sessionId, "sessionId"),
    sequence: safeInteger(input.sequence, "sequence"),
    revision: safeInteger(input.revision, "revision"),
    runtimeGeneration: safeInteger(
      input.runtimeGeneration,
      "runtimeGeneration",
    ),
    timestamp: string(input.timestamp, "timestamp"),
    type: string(input.type, "type"),
    payload: input.payload,
  };
}

export function parseHostProtocolError(value: unknown): HostProtocolError {
  const input = record(value, "host protocol error");
  if (typeof input.retryable !== "boolean") {
    throw new ProtocolDecodeError("retryable must be a boolean");
  }
  return {
    code: string(input.code, "code"),
    message: string(input.message, "message"),
    retryable: input.retryable,
    ...(input.details === undefined ? {} : { details: input.details }),
  };
}

function protocolRange(value: unknown): ProtocolRange {
  const input = record(value, "protocol range");
  const range = {
    minVersion: safeInteger(input.minVersion, "minVersion"),
    maxVersion: safeInteger(input.maxVersion, "maxVersion"),
  };
  if (range.minVersion > range.maxVersion) {
    throw new ProtocolDecodeError("minVersion must not exceed maxVersion");
  }
  return range;
}

function implementationInfo(value: unknown): ImplementationInfo {
  const input = record(value, "implementation info");
  return {
    name: string(input.name, "implementation.name"),
    version: string(input.version, "implementation.version"),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new ProtocolDecodeError(`${label} must be a non-empty string`);
  }
  return value;
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProtocolDecodeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}
