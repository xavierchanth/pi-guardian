import ipaddr from "ipaddr.js";

export const WEB_SEARCH_TOOL_NAME = "web_search";
export const WEB_FETCH_TOOL_NAME = "web_fetch";
export const WEB_SEARCH_MODEL = "openai-codex/gpt-5.6-terra";
export const WEB_REQUEST_TIMEOUT_MS = 90_000;
export const WEB_FETCH_TIMEOUT_MS = 20_000;
export const WEB_FETCH_MAX_REDIRECTS = 5;
export const WEB_FETCH_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
export const WEB_FETCH_MAX_OUTPUT_BYTES = 50 * 1024;
export const WEB_FETCH_MAX_OUTPUT_LINES = 2_000;
export const WEB_SEARCH_MAX_DOMAINS = 10;

const PRIVATE_NAME_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
] as const;

const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.azure.internal",
]);

export interface WebFetchReviewEvidence {
  type: "web-fetch";
  requestedUrl: string;
  canonicalUrl: string;
  hostname: string;
  method: "GET";
  sendsCredentials: false;
}

export type WebFetchPreflightDecision =
  | { kind: "review"; url: URL; evidence: WebFetchReviewEvidence }
  | { kind: "deny"; reason: string };

export function preflightWebFetch(input: Record<string, unknown>): WebFetchPreflightDecision {
  if (typeof input.url !== "string" || input.url.trim().length === 0) {
    return { kind: "deny", reason: "web_fetch requires a non-empty URL" };
  }
  try {
    const url = parseWebUrl(input.url);
    const hostname = normalizedHostname(url);
    if (isBlockedHostname(hostname)) {
      return { kind: "deny", reason: `web_fetch cannot access private or non-public host ${hostname}` };
    }
    if (ipaddr.isValid(hostname) && !isPublicAddress(hostname)) {
      return { kind: "deny", reason: `web_fetch cannot access non-public address ${hostname}` };
    }
    return {
      kind: "review",
      url,
      evidence: {
        type: "web-fetch",
        requestedUrl: input.url,
        canonicalUrl: url.href,
        hostname,
        method: "GET",
        sendsCredentials: false,
      },
    };
  } catch (error) {
    return {
      kind: "deny",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function parseWebUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("web_fetch URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("web_fetch supports only HTTP and HTTPS URLs");
  }
  if (url.username || url.password) {
    throw new Error("web_fetch URLs must not contain credentials");
  }
  if (!url.hostname) throw new Error("web_fetch URL must contain a hostname");
  return url;
}

export function normalizedHostname(url: URL): string {
  const hostname = url.hostname.toLowerCase();
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (METADATA_HOSTS.has(normalized)) return true;
  if (normalized === "localhost") return true;
  if (!ipaddr.isValid(normalized) && !normalized.includes(".")) return true;
  return PRIVATE_NAME_SUFFIXES.some(
    (suffix) => normalized === suffix.slice(1) || normalized.endsWith(suffix),
  );
}

export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address();
  }
  return parsed.range() === "unicast";
}

export function validateAllowedDomains(values: readonly string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) return undefined;
  if (values.length > WEB_SEARCH_MAX_DOMAINS) {
    throw new Error(`allowedDomains accepts at most ${WEB_SEARCH_MAX_DOMAINS} domains`);
  }
  const domains = values.map((value) => {
    const domain = value.trim().toLowerCase().replace(/\.$/, "");
    if (!domain || domain.includes("://") || /[/?#@:*\s]/.test(domain)) {
      throw new Error(`Invalid allowed domain: ${value}`);
    }
    let parsed: URL;
    try {
      parsed = new URL(`https://${domain}`);
    } catch {
      throw new Error(`Invalid allowed domain: ${value}`);
    }
    const hostname = normalizedHostname(parsed);
    if (hostname !== domain || isBlockedHostname(hostname) || ipaddr.isValid(hostname)) {
      throw new Error(`allowedDomains must contain public DNS hostnames: ${value}`);
    }
    return hostname;
  });
  return [...new Set(domains)];
}

export function combineWithTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
