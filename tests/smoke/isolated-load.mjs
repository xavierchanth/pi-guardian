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
let stateComplete = false;
let commandsComplete = false;
let complete = false;

function finishIfComplete() {
  if (!stateComplete || !commandsComplete) return;
  clearTimeout(timeout);
  complete = true;
  console.log("isolated Pi RPC load succeeded");
  child.kill("SIGTERM");
}

lines.on("line", (line) => {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event.type !== "response") return;
  if (event.command === "get_state") {
    if (event.success !== true) {
      console.error(`Pi get_state failed: ${line}\n${stderr}`);
      process.exitCode = 1;
      child.kill("SIGTERM");
      return;
    }
    stateComplete = true;
  }
  if (event.command === "get_commands") {
    const names = new Set(event.data?.commands?.map((command) => command.name) ?? []);
    const legacy = ["mode", "mode:auto", "mode:plan", "mode:edit", "mode:read", "review-mode", "implement"];
    if (
      event.success !== true ||
      !names.has("continue") ||
      !names.has("cap:list") ||
      !names.has("cap:subagents") ||
      !names.has("cap:jj-workspaces") ||
      !names.has("cap:git-worktrees") ||
      names.has("sub-agents") ||
      legacy.some((name) => names.has(name))
    ) {
      console.error(`Unexpected extension commands: ${line}\n${stderr}`);
      process.exitCode = 1;
      child.kill("SIGTERM");
      return;
    }
    commandsComplete = true;
  }
  finishIfComplete();
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
child.stdin.write(`${JSON.stringify({ type: "get_commands" })}\n`);
