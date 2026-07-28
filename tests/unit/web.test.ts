import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  isPublicAddress,
  preflightWebFetch,
  validateAllowedDomains,
} from "../../packages/pi-tai/src/web/domain.ts";
import { createWebFetcher } from "../../packages/pi-tai/src/web/fetch.ts";
import { resolvePublicAddress } from "../../packages/pi-tai/src/web/network.ts";
import { registerWebTools } from "../../packages/pi-tai/src/web/register.ts";
import { createWebSearcher } from "../../packages/pi-tai/src/web/search.ts";

test("web URL preflight rejects non-public and credentialed targets", () => {
  for (const url of [
    "file:///etc/passwd",
    "http://user:pass@example.com/",
    "http://localhost/",
    "http://service/",
    "http://api.internal/",
    "http://metadata.google.internal/",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://127.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
    "http://[::1]/",
    "http://[fd00::1]/",
  ]) {
    assert.equal(preflightWebFetch({ url }).kind, "deny", url);
  }
  const publicDecision = preflightWebFetch({ url: "https://Example.com/docs?q=1" });
  assert.equal(publicDecision.kind, "review");
  if (publicDecision.kind === "review") {
    assert.equal(publicDecision.evidence.canonicalUrl, "https://example.com/docs?q=1");
    assert.equal(publicDecision.evidence.sendsCredentials, false);
  }
});

test("address classification allows only globally routable unicast", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
  for (const address of [
    "0.0.0.0", "10.0.0.1", "100.100.100.200", "127.0.0.1", "169.254.170.2",
    "172.16.0.1", "192.168.1.1", "224.0.0.1", "::", "::1", "fe80::1", "fd00::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test("public resolver blocks private and mixed DNS answers", async () => {
  const url = new URL("https://docs.example.com/");
  await assert.rejects(
    resolvePublicAddress(url, async () => [{ address: "10.0.0.1", family: 4 }]),
    /non-public DNS/,
  );
  await assert.rejects(
    resolvePublicAddress(url, async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]),
    /mixed public and non-public/,
  );
  assert.deepEqual(
    await resolvePublicAddress(url, async () => [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "1.1.1.1", family: 4 },
    ]),
    { address: "1.1.1.1", family: 4 },
  );
});

test("allowed search domains are normalized and strictly public", () => {
  assert.deepEqual(
    validateAllowedDomains(["Docs.Example.com", "docs.example.com."]),
    ["docs.example.com"],
  );
  for (const value of ["https://example.com", "example.com/path", "localhost", "10.0.0.1", "*.example.com"]) {
    assert.throws(() => validateAllowedDomains([value]), /allowed domain|allowedDomains|Invalid/);
  }
});

test("hosted search uses only the OpenAI web tool and passes domain filters", async () => {
  let receivedContext: any;
  let receivedOptions: any;
  const usage = {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const search = createWebSearcher({
    complete: async (_model, context, options) => {
      receivedContext = context;
      receivedOptions = options;
      return {
        role: "assistant",
        content: [{ type: "text", text: "Answer [source](https://docs.example.com/)" }],
        stopReason: "stop",
        usage,
      } as never;
    },
  });
  const model = { provider: "openai-codex", id: "gpt-5.6-terra" };
  const ctx = {
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === model.provider && id === model.id ? model : undefined,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret", headers: { x: "y" } }),
    },
  } as unknown as ExtensionContext;

  const result = await search({
    query: " Find official docs ",
    allowedDomains: ["docs.example.com"],
  }, ctx);
  assert.equal(result.text, "Answer [source](https://docs.example.com/)");
  assert.equal(receivedContext.messages.length, 1);
  assert.equal(receivedContext.messages[0].content, "Find official docs");
  assert.equal(receivedContext.tools, undefined);
  const payload = receivedOptions.onPayload({ model: "gpt-5.6-terra", tools: [{ type: "function" }] });
  assert.deepEqual(payload.tools, [{
    type: "web_search",
    external_web_access: true,
    search_context_size: "high",
    filters: { allowed_domains: ["docs.example.com"] },
  }]);
  assert.equal(payload.tool_choice, "required");
  assert.equal(result.usage, usage);
});

test("web fetch follows public redirects and converts HTML to linked text", async () => {
  const requested: string[] = [];
  const fetch = createWebFetcher({
    resolver: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async (url) => {
      requested.push(url.href);
      if (url.pathname === "/start") {
        return { status: 302, headers: { location: "/docs" }, body: new Uint8Array() };
      }
      return {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: Buffer.from("<html><head><title>Docs</title></head><body><main><h1>Guide</h1><p>Read <a href='/api'>API docs</a>.</p></main></body></html>"),
      };
    },
  });
  const result = await fetch({ url: "https://example.com/start" });
  assert.deepEqual(requested, ["https://example.com/start", "https://example.com/docs"]);
  assert.match(result.text, /Guide/i);
  assert.match(result.text, /https:\/\/example\.com\/api/);
  assert.equal(result.details.title, "Docs");
  assert.deepEqual(result.details.redirects, ["https://example.com/docs"]);
});

test("web fetch rejects binary content and supports bounded continuation", async () => {
  const publicResolver = async () => [{ address: "93.184.216.34", family: 4 as const }];
  const binary = createWebFetcher({
    resolver: publicResolver,
    request: async () => ({
      status: 200,
      headers: { "content-type": "application/pdf" },
      body: Buffer.from("pdf"),
    }),
  });
  await assert.rejects(binary({ url: "https://example.com/a.pdf" }), /does not support/);

  const longText = Array.from({ length: 4_000 }, (_, index) => `line ${index}`).join("\n");
  const text = createWebFetcher({
    resolver: publicResolver,
    request: async () => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: Buffer.from(longText),
    }),
  });
  const first = await text({ url: "https://example.com/data.txt" });
  assert.equal(first.details.truncated, true);
  assert.ok(first.details.nextOffset);
  const second = await text({
    url: "https://example.com/data.txt",
    offset: first.details.nextOffset,
  });
  assert.match(second.text, /line 2000/);
});

test("web tools register their strict public interfaces", () => {
  const tools: any[] = [];
  const pi = {
    registerTool(tool: unknown) { tools.push(tool); },
  } as unknown as ExtensionAPI;
  registerWebTools(pi, {
    search: async () => ({ text: "ok", model: "openai-codex/test", usage: {} as never }),
    fetch: async () => ({
      text: "page",
      details: {
        requestedUrl: "https://example.com/",
        finalUrl: "https://example.com/",
        status: 200,
        contentType: "text/plain",
        downloadedBytes: 4,
        totalCharacters: 4,
        offset: 0,
        truncated: false,
        redirects: [],
      },
    }),
  });
  assert.deepEqual(tools.map(({ name }) => name), ["web_search", "web_fetch"]);
  assert.deepEqual(Object.keys(tools[0].parameters.properties), ["query", "allowedDomains"]);
  assert.deepEqual(Object.keys(tools[1].parameters.properties), ["url", "offset"]);
});
