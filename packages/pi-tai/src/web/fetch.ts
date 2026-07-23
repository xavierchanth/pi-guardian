import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { convert } from "html-to-text";
import {
  WEB_FETCH_MAX_OUTPUT_BYTES,
  WEB_FETCH_MAX_OUTPUT_LINES,
  WEB_FETCH_MAX_REDIRECTS,
  WEB_FETCH_TIMEOUT_MS,
  combineWithTimeout,
  parseWebUrl,
} from "./domain.ts";
import {
  requestWeb,
  resolveHost,
  resolvePublicAddress,
  type HostResolver,
  type RawWebResponse,
  type WebRequest,
} from "./network.ts";

export interface WebFetchInput {
  url: string;
  offset?: number;
}

export interface WebFetchDetails {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  downloadedBytes: number;
  totalCharacters: number;
  offset: number;
  nextOffset?: number;
  truncated: boolean;
  redirects: string[];
  title?: string;
}

export interface WebFetchResult {
  text: string;
  details: WebFetchDetails;
}

export interface WebFetchDependencies {
  resolver?: HostResolver;
  request?: WebRequest;
}

export type WebFetcher = (
  input: WebFetchInput,
  signal?: AbortSignal,
) => Promise<WebFetchResult>;

export function createWebFetcher(dependencies: WebFetchDependencies = {}): WebFetcher {
  const resolver = dependencies.resolver ?? resolveHost;
  const request = dependencies.request ?? requestWeb;
  return async (input, signal) => {
    const requested = parseWebUrl(input.url);
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("web_fetch offset must be a non-negative integer");
    }
    const effectiveSignal = combineWithTimeout(signal, WEB_FETCH_TIMEOUT_MS);
    const { response, finalUrl, redirects } = await followRedirects(
      requested,
      resolver,
      request,
      effectiveSignal,
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`web_fetch received HTTP ${response.status} from ${finalUrl.href}`);
    }
    const contentTypeHeader = firstHeader(response.headers["content-type"]);
    const contentType = (contentTypeHeader?.split(";", 1)[0] ?? "application/octet-stream")
      .trim()
      .toLowerCase();
    const decoded = decodeText(response.body, contentTypeHeader);
    const formatted = formatContent(decoded, contentType, finalUrl);
    if (offset > formatted.text.length) {
      throw new Error(`web_fetch offset ${offset} exceeds content length ${formatted.text.length}`);
    }
    const remaining = formatted.text.slice(offset);
    const truncation = truncateHead(remaining, {
      maxBytes: WEB_FETCH_MAX_OUTPUT_BYTES,
      maxLines: WEB_FETCH_MAX_OUTPUT_LINES,
    });
    if (truncation.firstLineExceedsLimit) {
      throw new Error("web_fetch content contains a line too large to return safely");
    }
    const nextOffset = truncation.truncated ? offset + truncation.content.length : undefined;
    const suffix = truncation.truncated
      ? `\n\n[Output truncated at ${formatSize(truncation.outputBytes)}; call web_fetch again with offset ${nextOffset}.]`
      : "";
    return {
      text: `${truncation.content}${suffix}`,
      details: {
        requestedUrl: requested.href,
        finalUrl: finalUrl.href,
        status: response.status,
        contentType,
        downloadedBytes: response.body.byteLength,
        totalCharacters: formatted.text.length,
        offset,
        ...(nextOffset !== undefined ? { nextOffset } : {}),
        truncated: truncation.truncated,
        redirects,
        ...(formatted.title ? { title: formatted.title } : {}),
      },
    };
  };
}

export const fetchWeb = createWebFetcher();

async function followRedirects(
  initialUrl: URL,
  resolver: HostResolver,
  request: WebRequest,
  signal: AbortSignal,
): Promise<{ response: RawWebResponse; finalUrl: URL; redirects: string[] }> {
  let url = initialUrl;
  const redirects: string[] = [];
  for (let count = 0; count <= WEB_FETCH_MAX_REDIRECTS; count++) {
    const address = await resolvePublicAddress(url, resolver);
    const response = await request(url, address, signal);
    if (!isRedirect(response.status)) return { response, finalUrl: url, redirects };
    if (count === WEB_FETCH_MAX_REDIRECTS) {
      throw new Error(`web_fetch exceeded ${WEB_FETCH_MAX_REDIRECTS} redirects`);
    }
    const location = firstHeader(response.headers.location);
    if (!location) throw new Error(`web_fetch received HTTP ${response.status} without Location`);
    url = parseWebUrl(new URL(location, url).href);
    redirects.push(url.href);
  }
  throw new Error("web_fetch redirect handling failed");
}

function formatContent(
  text: string,
  contentType: string,
  finalUrl: URL,
): { text: string; title?: string } {
  if (contentType === "text/html" || contentType === "application/xhtml+xml") {
    const title = extractHtmlTitle(text);
    return {
      text: convert(text, {
        wordwrap: false,
        baseElements: {
          selectors: ["main", "article"],
          orderBy: "occurrence",
          returnDomByDefault: true,
        },
        selectors: [
          {
            selector: "a",
            options: {
              hideLinkHrefIfSameAsText: true,
              pathRewrite: (path: string) => resolveLink(path, finalUrl),
            },
          },
          { selector: "img", format: "skip" },
          { selector: "script", format: "skip" },
          { selector: "style", format: "skip" },
          { selector: "noscript", format: "skip" },
          { selector: "svg", format: "skip" },
        ],
      }).trim(),
      ...(title ? { title } : {}),
    };
  }
  if (contentType === "application/json" || contentType.endsWith("+json")) {
    try {
      return { text: JSON.stringify(JSON.parse(text), null, 2) };
    } catch {
      return { text };
    }
  }
  if (
    contentType.startsWith("text/")
    || contentType === "application/xml"
    || contentType.endsWith("+xml")
    || contentType === "application/javascript"
    || contentType === "application/x-javascript"
  ) {
    return { text };
  }
  throw new Error(`web_fetch does not support content type ${contentType}`);
}

function decodeText(body: Uint8Array, contentType: string | undefined): string {
  const charset = contentType?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

function resolveLink(path: string, base: URL): string {
  try {
    return new URL(path, base).href;
  } catch {
    return path;
  }
}

function extractHtmlTitle(html: string): string | undefined {
  const match = html.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i);
  if (!match) return undefined;
  return convert(match[1], { wordwrap: false }).trim() || undefined;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
