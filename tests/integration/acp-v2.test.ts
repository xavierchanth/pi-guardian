import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  PROTOCOL_VERSION,
  client,
  methods,
} from "@agentclientprotocol/sdk/experimental/v2";
import { createPrototypeAcpAgent } from "../../bins/acp/src/app.ts";

const root = process.cwd();

test("ACP v2 SDK and schema pin match reviewed fixture metadata", async () => {
  const pin = JSON.parse(await readFile(join(root, "fixtures/acp-v2/pin.json"), "utf8")) as {
    sdkVersion: string;
    sdkIntegrity: string;
    schemaPath: string;
    schemaSha256: string;
  };
  const packageJson = JSON.parse(await readFile(
    join(root, "node_modules/@agentclientprotocol/sdk/package.json"),
    "utf8",
  )) as { version: string };
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")) as {
    packages: Record<string, { integrity?: string }>;
  };
  const schema = await readFile(join(root, pin.schemaPath));

  assert.equal(packageJson.version, pin.sdkVersion);
  assert.equal(
    lock.packages["node_modules/@agentclientprotocol/sdk"]?.integrity,
    pin.sdkIntegrity,
  );
  assert.equal(createHash("sha256").update(schema).digest("hex"), pin.schemaSha256);
});

test("official in-process ACP v2 harness negotiates without over-advertising sessions", async () => {
  const harness = client({ name: "pi-tai-acp-proof-client" });
  await harness.connectWith(createPrototypeAcpAgent(), async (agent) => {
    const initialized = await agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      info: { name: "proof-client", version: "0.1.0" },
      capabilities: {},
    });

    assert.equal(initialized.protocolVersion, PROTOCOL_VERSION);
    assert.equal(initialized.info.name, "pi-tai-acp");
    assert.equal(initialized.capabilities?.session, undefined);
  });
});
