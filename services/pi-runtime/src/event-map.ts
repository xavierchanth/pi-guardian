import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RuntimeEventInput } from "./runtime-port.ts";

export function mapAgentSessionEvent(
  event: AgentSessionEvent,
  context: { commandId: string; sessionId: string; turnId: string },
): RuntimeEventInput | undefined {
  const base = context;
  switch (event.type) {
    case "agent_start":
      return { ...base, event: "agent.start", data: {} };
    case "agent_end":
      return { ...base, event: "agent.end", data: { willRetry: event.willRetry } };
    case "agent_settled":
      return { ...base, event: "session.idle", data: {} };
    case "turn_start":
      return { ...base, event: "turn.start", data: {} };
    case "turn_end":
      return { ...base, event: "turn.end", data: {} };
    case "message_start":
      return { ...base, event: "message.start", data: { role: event.message.role } };
    case "message_end": {
      const message = event.message as typeof event.message & { id?: string; timestamp?: number; provider?: string; model?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } } };
      return {
        ...base,
        event: "message.end",
        data: {
          role: message.role,
          ...(message.id ? { messageId: message.id } : message.timestamp ? { messageId: String(message.timestamp) } : {}),
          ...(message.provider ? { provider: message.provider } : {}),
          ...(message.model ? { model: message.model } : {}),
          ...(message.usage ? { usage: message.usage } : {}),
        },
      };
    }
    case "message_update": {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        return { ...base, event: "assistant.text_delta", data: { delta: update.delta } };
      }
      if (update.type === "thinking_delta") {
        return { ...base, event: "assistant.thinking_delta", data: { delta: update.delta } };
      }
      return undefined;
    }
    case "tool_execution_start":
      return {
        ...base,
        event: "tool.start",
        data: { toolCallId: event.toolCallId, toolName: event.toolName },
      };
    case "tool_execution_update":
      return {
        ...base,
        event: "tool.update",
        data: { toolCallId: event.toolCallId, toolName: event.toolName },
      };
    case "tool_execution_end":
      return {
        ...base,
        event: "tool.end",
        data: { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError },
      };
    case "queue_update":
      return {
        ...base,
        event: "queue.changed",
        data: { steeringCount: event.steering.length, followUpCount: event.followUp.length },
      };
    case "session_info_changed":
      return {
        ...base,
        event: "session.title_changed",
        data: event.name === undefined ? {} : { title: event.name },
      };
    case "thinking_level_changed":
      return { ...base, event: "session.thinking_changed", data: { level: event.level } };
    default:
      return undefined;
  }
}
