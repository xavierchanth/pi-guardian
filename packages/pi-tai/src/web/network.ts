import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import {
  WEB_FETCH_MAX_DOWNLOAD_BYTES,
  isBlockedHostname,
  isPublicAddress,
  normalizedHostname,
} from "./domain.ts";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type HostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface RawWebResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Uint8Array;
  remoteAddress?: string;
}

export type WebRequest = (
  url: URL,
  address: ResolvedAddress,
  signal: AbortSignal,
) => Promise<RawWebResponse>;

export const resolveHost: HostResolver = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));
};

export async function resolvePublicAddress(
  url: URL,
  resolver: HostResolver = resolveHost,
): Promise<ResolvedAddress> {
  const hostname = normalizedHostname(url);
  if (isBlockedHostname(hostname)) {
    throw new Error(`web_fetch blocked private or non-public host ${hostname}`);
  }
  const addresses = isIpLiteral(hostname)
    ? [{ address: hostname, family: hostname.includes(":") ? 6 as const : 4 as const }]
    : await resolver(hostname);
  if (addresses.length === 0) throw new Error(`web_fetch could not resolve ${hostname}`);
  const nonPublic = addresses.filter(({ address }) => !isPublicAddress(address));
  if (nonPublic.length > 0) {
    const mixed = nonPublic.length !== addresses.length;
    throw new Error(
      mixed
        ? `web_fetch blocked mixed public and non-public DNS answers for ${hostname}`
        : `web_fetch blocked non-public DNS answers for ${hostname}`,
    );
  }
  return addresses.find(({ family }) => family === 4) ?? addresses[0];
}

export const requestWeb: WebRequest = (url, address, signal) => new Promise((resolve, reject) => {
  const lookup: LookupFunction = (_hostname, _options, callback) => {
    callback(null, address.address, address.family);
  };
  const request = (url.protocol === "https:" ? https : http).request(url, {
    method: "GET",
    signal,
    lookup,
    headers: {
      accept: "text/markdown, text/plain;q=0.95, text/html;q=0.9, application/json;q=0.8, application/xml;q=0.7, text/xml;q=0.7",
      "accept-encoding": "identity",
      "user-agent": "pi-tai-web-fetch/0.1",
    },
  }, (response) => {
    const remoteAddress = response.socket.remoteAddress;
    if (!remoteAddress || !isPublicAddress(remoteAddress)) {
      response.destroy(new Error("web_fetch connection reached a non-public address"));
      return;
    }
    const declaredLength = Number(response.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > WEB_FETCH_MAX_DOWNLOAD_BYTES) {
      response.destroy(new Error(`web_fetch response exceeds ${WEB_FETCH_MAX_DOWNLOAD_BYTES} bytes`));
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    response.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > WEB_FETCH_MAX_DOWNLOAD_BYTES) {
        response.destroy(new Error(`web_fetch response exceeds ${WEB_FETCH_MAX_DOWNLOAD_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => resolve({
      status: response.statusCode ?? 0,
      headers: response.headers,
      body: Buffer.concat(chunks),
      remoteAddress,
    }));
    response.on("error", reject);
  });
  request.on("error", reject);
  request.end();
});

function isIpLiteral(hostname: string): boolean {
  return /^[0-9.]+$/.test(hostname) || hostname.includes(":");
}
