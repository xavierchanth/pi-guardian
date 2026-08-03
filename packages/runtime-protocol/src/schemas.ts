import { z } from "zod";
import type {
  AcceptedResult,
  ConfigProvenance,
  EmptyParams,
  EmptyResult,
  HostServiceResponseParams,
  InterruptionData,
  ModelInfo,
  ProtocolRange,
  QueueData,
  RuntimeCapabilities,
  RuntimeCommand,
  RuntimeEvent,
  RuntimeInitializeParams,
  RuntimeInitializeResult,
  RuntimeProtocolError,
  RuntimeResponse,
  SessionCancelParams,
  SessionCreateParams,
  SessionInfo,
  SessionOpenParams,
  SessionPolicy,
  SessionPromptParams,
  SessionRelocateWorkspaceParams,
  SessionSetModelParams,
  SessionSetThinkingParams,
  SessionTextParams,
  SessionTitleData,
  TextDeltaData,
  ThinkingInfo,
  ToolLifecycleData,
} from "./generated.ts";

export const CURRENT_RUNTIME_PROTOCOL_VERSION = 3;
export const MAX_PROTOCOL_STRING_LENGTH = 1_000_000;

const nonEmptyString = z.string().min(1).max(MAX_PROTOCOL_STRING_LENGTH);
const safeUInt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const jsonValue = z.json();
const strictEmpty = z.object({}).strict();

export const ProtocolRangeSchema: z.ZodType<ProtocolRange> = z
  .object({
    minVersion: safeUInt,
    maxVersion: safeUInt,
  })
  .strict()
  .refine((range) => range.minVersion <= range.maxVersion, {
    message: "minVersion must not exceed maxVersion",
  });

export const RuntimeProtocolErrorSchema: z.ZodType<RuntimeProtocolError> = z
  .object({
    code: nonEmptyString,
    message: nonEmptyString,
    retryable: z.boolean(),
    details: jsonValue.optional(),
  })
  .strict();

export const RuntimeCommandSchema: z.ZodType<RuntimeCommand> = z
  .object({
    protocolVersion: safeUInt,
    kind: z.literal("command"),
    id: nonEmptyString,
    method: nonEmptyString,
    params: jsonValue,
  })
  .strict();

export const RuntimeResponseSchema: z.ZodType<RuntimeResponse> = z
  .object({
    protocolVersion: z.literal(CURRENT_RUNTIME_PROTOCOL_VERSION),
    kind: z.literal("response"),
    id: nonEmptyString,
    ok: z.boolean(),
    result: jsonValue.optional(),
    error: RuntimeProtocolErrorSchema.optional(),
  })
  .strict()
  .superRefine((response, context) => {
    if (response.ok && response.error !== undefined) {
      context.addIssue({
        code: "custom",
        message: "successful responses cannot include error",
        path: ["error"],
      });
    }
    if (!response.ok && response.error === undefined) {
      context.addIssue({
        code: "custom",
        message: "failed responses require error",
        path: ["error"],
      });
    }
  });

export const RuntimeEventSchema: z.ZodType<RuntimeEvent> = z
  .object({
    protocolVersion: z.literal(CURRENT_RUNTIME_PROTOCOL_VERSION),
    kind: z.literal("event"),
    workerSequence: safeUInt,
    runtimeGeneration: safeUInt,
    event: nonEmptyString,
    commandId: nonEmptyString.optional(),
    sessionId: nonEmptyString.optional(),
    turnId: nonEmptyString.optional(),
    data: jsonValue,
  })
  .strict();

export const RuntimeInitializeParamsSchema: z.ZodType<RuntimeInitializeParams> = z
  .object({
    protocol: ProtocolRangeSchema,
    workerId: nonEmptyString,
    runtimeGeneration: safeUInt,
  })
  .strict();

const SessionPolicySchema: z.ZodType<SessionPolicy> = z
  .object({
    compaction: z
      .object({
        enabled: z.boolean(),
        thresholdPercent: z.number().finite().min(1).max(100),
      })
      .strict(),
    modelProfiles: z.array(
      z
        .object({
          name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
          provider: nonEmptyString,
          model: nonEmptyString,
          effort: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
        })
        .strict(),
    ),
  })
  .strict();

const ConfigProvenanceSchema: z.ZodType<ConfigProvenance> = z.record(
  z.string(),
  z
    .object({
      layer: z.enum(["default", "machine", "user", "project"]),
      path: nonEmptyString.optional(),
      digest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .strict(),
);

export const SessionCreateParamsSchema: z.ZodType<SessionCreateParams> = z
  .object({
    cwd: nonEmptyString,
    rootSessionId: nonEmptyString.nullish().transform((value) => value ?? null),
    runtimeGeneration: safeUInt.nullish().transform((value) => value ?? null),
    agentDir: nonEmptyString,
    sessionDir: nonEmptyString,
    sessionPolicy: SessionPolicySchema,
    policyProvenance: ConfigProvenanceSchema,
    faux: z.boolean().optional(),
  })
  .strict();

export const SessionOpenParamsSchema: z.ZodType<SessionOpenParams> = z
  .object({
    sessionFile: nonEmptyString,
    rootSessionId: nonEmptyString.nullish().transform((value) => value ?? null),
    runtimeGeneration: safeUInt.nullish().transform((value) => value ?? null),
    agentDir: nonEmptyString,
    sessionDir: nonEmptyString,
    sessionPolicy: SessionPolicySchema,
    policyProvenance: ConfigProvenanceSchema,
    faux: z.boolean().optional(),
  })
  .strict();

export const SessionPromptParamsSchema: z.ZodType<SessionPromptParams> = z
  .object({
    turnId: nonEmptyString,
    text: nonEmptyString,
  })
  .strict();

export const SessionTextParamsSchema: z.ZodType<SessionTextParams> = z
  .object({
    text: nonEmptyString,
  })
  .strict();

export const SessionCancelParamsSchema: z.ZodType<SessionCancelParams> = z
  .object({
    turnId: nonEmptyString,
  })
  .strict();

export const HostServiceResponseParamsSchema: z.ZodType<HostServiceResponseParams> = z
  .object({
    requestId: nonEmptyString,
    ok: z.boolean(),
    result: jsonValue.optional(),
    error: RuntimeProtocolErrorSchema.optional(),
  })
  .strict()
  .superRefine((response, context) => {
    if (response.ok && response.error !== undefined)
      context.addIssue({
        code: "custom",
        message: "successful Host service responses cannot include error",
        path: ["error"],
      });
    if (!response.ok && response.error === undefined)
      context.addIssue({
        code: "custom",
        message: "failed Host service responses require error",
        path: ["error"],
      });
  });

export const SessionSetModelParamsSchema: z.ZodType<SessionSetModelParams> = z
  .object({
    provider: nonEmptyString,
    model: nonEmptyString,
  })
  .strict();

export const ThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const SessionSetThinkingParamsSchema: z.ZodType<SessionSetThinkingParams> = z
  .object({
    level: ThinkingLevelSchema,
  })
  .strict();

export const SessionRelocateWorkspaceParamsSchema: z.ZodType<SessionRelocateWorkspaceParams> = z
  .object({
    backend: z.enum(["jj", "git"]),
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
  })
  .strict();

export const EmptyParamsSchema: z.ZodType<EmptyParams> = strictEmpty;

export const RuntimeCapabilitiesSchema: z.ZodType<RuntimeCapabilities> = z
  .object({
    methods: z.array(nonEmptyString),
    tools: z.array(nonEmptyString),
    commands: z.array(nonEmptyString),
    extensionErrors: z.array(nonEmptyString),
  })
  .strict();

export const RuntimeInitializeResultSchema: z.ZodType<RuntimeInitializeResult> = z
  .object({
    protocolVersion: z.literal(CURRENT_RUNTIME_PROTOCOL_VERSION),
    workerId: nonEmptyString,
    runtimeGeneration: safeUInt,
    capabilities: RuntimeCapabilitiesSchema,
  })
  .strict();

export const SessionInfoSchema: z.ZodType<SessionInfo> = z
  .object({
    sessionId: nonEmptyString,
    sessionFile: nonEmptyString,
    cwd: nonEmptyString,
  })
  .strict();
export const AcceptedResultSchema: z.ZodType<AcceptedResult> = z
  .object({ accepted: z.boolean() })
  .strict();
export const EmptyResultSchema: z.ZodType<EmptyResult> = strictEmpty;
export const ModelInfoSchema: z.ZodType<ModelInfo> = z
  .object({ provider: nonEmptyString, model: nonEmptyString })
  .strict();
export const ThinkingInfoSchema: z.ZodType<ThinkingInfo> = z
  .object({ level: ThinkingLevelSchema })
  .strict();
export const TextDeltaDataSchema: z.ZodType<TextDeltaData> = z
  .object({ delta: z.string() })
  .strict();
export const ToolLifecycleDataSchema: z.ZodType<ToolLifecycleData> = z
  .object({
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    isError: z.boolean().optional(),
  })
  .strict();
export const QueueDataSchema: z.ZodType<QueueData> = z
  .object({
    steeringCount: safeUInt,
    followUpCount: safeUInt,
  })
  .strict();
export const SessionTitleDataSchema: z.ZodType<SessionTitleData> = z
  .object({ title: z.string().optional() })
  .strict();
export const InterruptionDataSchema: z.ZodType<InterruptionData> = z
  .object({ reason: nonEmptyString })
  .strict();
