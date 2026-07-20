import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  ProtocolDecodeError,
  ProtocolNegotiationError,
  negotiateProtocol,
  parseClientHello,
  parseHostCommand,
  parseHostEvent,
  parseHostHello,
  parseHostProtocolError,
  type ClientHello,
  type HostCommand,
  type HostEvent,
  type HostHello,
  type HostProtocolError,
  type ProtocolRange,
} from "../../packages/host-protocol/src/index.ts";

const fixtureRoot = resolve(import.meta.dirname, "../../fixtures/host-protocol");

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixtureRoot, name), "utf8")) as T;
}

test("TypeScript consumes the shared Host protocol fixtures", () => {
  const client = parseClientHello(fixture<ClientHello>("client-hello.json"));
  const host = parseHostHello(fixture<HostHello>("host-hello.json"));
  const command = parseHostCommand(
    fixture<HostCommand<{ text: string }>>("command-prompt.json"),
  ) as HostCommand<{ text: string }>;
  const event = parseHostEvent(
    fixture<HostEvent<{ delta: string }>>("event-text-delta.json"),
  ) as HostEvent<{ delta: string }>;
  const error = parseHostProtocolError(
    fixture<HostProtocolError>("error-version-mismatch.json"),
  );

  assert.equal(client.clientKind, "acp");
  assert.equal(host.protocolVersion, 1);
  assert.equal(command.kind, "session.prompt");
  assert.equal(command.payload.text, "Continue the implementation");
  assert.equal(event.sequence, 42);
  assert.equal(event.type, "assistant.text_delta");
  assert.equal(error.code, "protocol_version_mismatch");
});

test("TypeScript and Rust negotiation cases share highest-overlap semantics", () => {
  const cases = fixture<Array<{
    name: string;
    client: ProtocolRange;
    host: ProtocolRange;
    selected: number | null;
  }>>("negotiation-cases.json");

  for (const entry of cases) {
    if (entry.selected === null) {
      assert.throws(
        () => negotiateProtocol(entry.client, entry.host),
        ProtocolNegotiationError,
        entry.name,
      );
    } else {
      assert.equal(
        negotiateProtocol(entry.client, entry.host),
        entry.selected,
        entry.name,
      );
    }
  }
});

test("runtime decoders reject malformed or unsafe envelopes", () => {
  assert.throws(
    () => parseHostEvent({
      protocolVersion: 1,
      sessionId: "session-1",
      sequence: Number.MAX_SAFE_INTEGER + 1,
      revision: 1,
      runtimeGeneration: 1,
      timestamp: "now",
      type: "event",
      payload: {},
    }),
    ProtocolDecodeError,
  );
  assert.throws(
    () => parseClientHello({
      protocol: { minVersion: 2, maxVersion: 1 },
      implementation: { name: "bad", version: "1" },
      clientKind: "unknown",
    }),
    ProtocolDecodeError,
  );
});

test("incompatible protocol errors preserve both advertised ranges", () => {
  const client = { minVersion: 2, maxVersion: 3 };
  const host = { minVersion: 1, maxVersion: 1 };

  assert.throws(
    () => negotiateProtocol(client, host),
    (error: unknown) => {
      assert.ok(error instanceof ProtocolNegotiationError);
      assert.deepEqual(error.client, client);
      assert.deepEqual(error.host, host);
      return true;
    },
  );
});
