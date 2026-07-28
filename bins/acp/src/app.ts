import {
  PROTOCOL_VERSION,
  agent,
  methods,
  type AgentApp,
} from "@agentclientprotocol/sdk/experimental/v2";

export const ACP_V2_DRAFT_VERSION = PROTOCOL_VERSION;

export function createPrototypeAcpAgent(): AgentApp {
  return agent({ name: "pi-tai-acp" }).onRequest(
    methods.agent.initialize,
    ({ params }) => ({
      protocolVersion: params.protocolVersion === PROTOCOL_VERSION
        ? params.protocolVersion
        : PROTOCOL_VERSION,
      info: {
        name: "pi-tai-acp",
        title: "Pi-Tai",
        version: "0.1.0",
      },
      // Do not advertise the session surface until every v2 baseline method is wired.
      capabilities: {},
    }),
  );
}
