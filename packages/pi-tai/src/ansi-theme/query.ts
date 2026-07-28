import { spawn } from "node:child_process";

export type QueryTerminalBackground = (
  signal?: AbortSignal,
) => Promise<string | undefined>;

const OSC_QUERY_SCRIPT = String.raw`
const fs = require("fs");
const tty = require("tty");
function parseRgb(spec) {
  const match = /^rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)$/i.exec(spec);
  if (!match) return undefined;
  const hex = match.slice(1).map((part) => (part.length > 2 ? part.slice(0, 2) : part.padEnd(2, part))).join("");
  return "#" + hex.toLowerCase();
}
function parseResponse(value) {
  const match = /\x1b\]11;(rgb:[^\x07\x1b]+)(?:\x07|\x1b\\)/.exec(value);
  return match ? parseRgb(match[1]) : undefined;
}
let fd;
try { fd = fs.openSync("/dev/tty", "r+"); } catch { process.exit(1); }
const input = new tty.ReadStream(fd);
let raw = false;
let buffer = "";
let done = false;
let timer;
function finish(background) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  try { if (raw) input.setRawMode(false); } catch {}
  try { input.destroy(); } catch {}
  if (background) process.stdout.write(JSON.stringify({ background }));
}
try { input.setRawMode(true); raw = true; } catch { finish(); process.exit(1); }
timer = setTimeout(() => finish(parseResponse(buffer)), 500);
input.on("data", (chunk) => {
  buffer += chunk.toString("binary");
  const background = parseResponse(buffer);
  if (background) finish(background);
});
input.on("error", () => finish());
try { fs.writeSync(fd, "\x1b]11;?\x07"); } catch { finish(); }
`;

export const queryTerminalBackground: QueryTerminalBackground = (signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(undefined);
      return;
    }

    const child = spawn(process.execPath, ["-e", OSC_QUERY_SCRIPT], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    let settled = false;
    const finish = (background?: string) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolve(background);
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish();
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", () => finish());
    child.on("close", () => {
      try {
        const parsed = JSON.parse(output) as { background?: unknown };
        finish(typeof parsed.background === "string" ? parsed.background : undefined);
      } catch {
        finish();
      }
    });
  });
