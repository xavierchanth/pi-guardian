import type { z } from "zod";
import {
  AcceptedResultSchema,
  EmptyParamsSchema,
  EmptyResultSchema,
  HostServiceResponseParamsSchema,
  ModelInfoSchema,
  RuntimeCapabilitiesSchema,
  RuntimeInitializeParamsSchema,
  RuntimeInitializeResultSchema,
  SessionCancelParamsSchema,
  SessionCreateParamsSchema,
  SessionInfoSchema,
  SessionOpenParamsSchema,
  SessionPromptParamsSchema,
  SessionRelocateWorkspaceParamsSchema,
  SessionSetCapabilityParamsSchema,
  SessionSetModelParamsSchema,
  SessionSetThinkingParamsSchema,
  SessionTextParamsSchema,
  ThinkingInfoSchema,
} from "./schemas.ts";

export const RUNTIME_METHODS = [
  "runtime.initialize",
  "session.create",
  "session.open",
  "session.prompt",
  "session.steer",
  "session.follow_up",
  "session.cancel",
  "host.service_response",
  "session.set_model",
  "session.set_thinking",
  "session.set_capability",
  "session.relocate_workspace",
  "session.dispose",
  "runtime.shutdown",
] as const;

export type RuntimeMethod = (typeof RUNTIME_METHODS)[number];

type MethodDefinition = {
  params: z.ZodType;
  result: z.ZodType;
};

export const runtimeMethodRegistry = {
  "runtime.initialize": {
    params: RuntimeInitializeParamsSchema,
    result: RuntimeInitializeResultSchema,
  },
  "session.create": { params: SessionCreateParamsSchema, result: SessionInfoSchema },
  "session.open": { params: SessionOpenParamsSchema, result: SessionInfoSchema },
  "session.prompt": { params: SessionPromptParamsSchema, result: AcceptedResultSchema },
  "session.steer": { params: SessionTextParamsSchema, result: AcceptedResultSchema },
  "session.follow_up": { params: SessionTextParamsSchema, result: AcceptedResultSchema },
  "session.cancel": { params: SessionCancelParamsSchema, result: AcceptedResultSchema },
  "host.service_response": { params: HostServiceResponseParamsSchema, result: EmptyResultSchema },
  "session.set_model": { params: SessionSetModelParamsSchema, result: ModelInfoSchema },
  "session.set_thinking": { params: SessionSetThinkingParamsSchema, result: ThinkingInfoSchema },
  "session.set_capability": {
    params: SessionSetCapabilityParamsSchema,
    result: RuntimeCapabilitiesSchema,
  },
  "session.relocate_workspace": {
    params: SessionRelocateWorkspaceParamsSchema,
    result: SessionInfoSchema,
  },
  "session.dispose": { params: EmptyParamsSchema, result: EmptyResultSchema },
  "runtime.shutdown": { params: EmptyParamsSchema, result: EmptyResultSchema },
} as const satisfies Record<RuntimeMethod, MethodDefinition>;

export function isRuntimeMethod(method: string): method is RuntimeMethod {
  return Object.hasOwn(runtimeMethodRegistry, method);
}

export type RuntimeMethodParams<M extends RuntimeMethod> = z.output<
  (typeof runtimeMethodRegistry)[M]["params"]
>;
export type RuntimeMethodResult<M extends RuntimeMethod> = z.output<
  (typeof runtimeMethodRegistry)[M]["result"]
>;
