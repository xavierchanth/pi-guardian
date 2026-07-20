import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const child = spawn("pi", ["-ne", "-e", ".", "--mode", "rpc"], {
  cwd: root,
  env: { ...process.env, PI_OFFLINE: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const timeout = setTimeout(() => {
  child.kill("SIGTERM");
  console.error(`isolated Pi load timed out\n${stderr}`);
  process.exitCode = 1;
}, 10_000);

const lines = createInterface({ input: child.stdout });
let complete = false;
lines.on("line", (line) => {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event.type !== "response" || event.command !== "get_state") return;
  clearTimeout(timeout);
  complete = event.success === true;
  if (!complete) {
    console.error(`Pi get_state failed: ${line}\n${stderr}`);
    process.exitCode = 1;
  } else {
    console.log("isolated Pi RPC load succeeded");
  }
  child.kill("SIGTERM");
});

child.on("error", (error) => {
  clearTimeout(timeout);
  console.error(error);
  process.exitCode = 1;
});

child.on("exit", () => {
  clearTimeout(timeout);
  if (!complete && process.exitCode === undefined) {
    console.error(`Pi exited before get_state response\n${stderr}`);
    process.exitCode = 1;
  }
});

child.stdin.write(`${JSON.stringify({ type: "get_state" })}\n`);
