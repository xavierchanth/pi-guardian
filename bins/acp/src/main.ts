#!/usr/bin/env -S node --experimental-strip-types

import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk/experimental/v2";
import { createHostBackedAcpAgent } from "./host-agent.ts";
import { HostBrokerPort } from "./host-port.ts";

async function main() {
  if (!process.argv.includes("--experimental-acp-v2")) {
    throw new Error("Pi-Tai ACP v2 is experimental; pass --experimental-acp-v2 to opt in.");
  }
  const socketPath = requiredEnvironment("PI_TAI_HOST_SOCKET");
  const tokenFile = requiredEnvironment("PI_TAI_HOST_TOKEN_FILE");
  const port = new HostBrokerPort({ socketPath, tokenFile });
  const app = createHostBackedAcpAgent(port);
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  const connection = app.connect(stream);
  await connection.closed;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown ACP failure.";
  process.stderr.write(`pi-tai-acp: ${message}\n`);
  process.exitCode = 1;
});
