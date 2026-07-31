import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const bootstrap = resolve(root, "services/pi-runtime/src/bootstrap.ts");

export class RuntimeProcessHarness {
  readonly child: ChildProcessWithoutNullStreams;
  readonly frames: any[] = [];
  stderr = "";
  private readonly events = new EventEmitter();
  private buffer = Buffer.alloc(0);

  constructor(
    options: { env?: NodeJS.ProcessEnv; executable?: string; args?: string[]; cwd?: string } = {},
  ) {
    this.child = spawn(
      options.executable ?? process.execPath,
      options.args ?? ["--experimental-strip-types", bootstrap],
      {
        cwd: options.cwd ?? root,
        env: { ...process.env, ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child.stdout.on("data", (chunk: Buffer) => this.push(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.child.once("exit", (code, signal) => this.events.emit("exit", { code, signal }));
  }

  send(frame: unknown): void {
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  command(id: string, method: string, params: unknown): Promise<any> {
    this.send({ protocolVersion: 3, kind: "command", id, method, params });
    return this.waitFor((frame) => frame.kind === "response" && frame.id === id);
  }

  waitFor(predicate: (frame: any) => boolean, timeoutMs = 10_000): Promise<any> {
    const existing = this.frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveWait, reject) => {
      const onFrame = (frame: any) => {
        if (!predicate(frame)) return;
        cleanup();
        resolveWait(frame);
      };
      const onExit = (exit: unknown) => {
        cleanup();
        reject(
          new Error(`worker exited before expected frame: ${JSON.stringify(exit)}\n${this.stderr}`),
        );
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`worker frame timeout\n${this.stderr}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        this.events.off("frame", onFrame);
        this.events.off("exit", onExit);
      };
      this.events.on("frame", onFrame);
      this.events.on("exit", onExit);
    });
  }

  waitForExit(timeoutMs = 5_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return Promise.resolve({ code: this.child.exitCode, signal: this.child.signalCode });
    }
    return new Promise((resolveExit, reject) => {
      const timeout = setTimeout(() => {
        this.child.kill("SIGKILL");
        reject(new Error(`worker exit timeout\n${this.stderr}`));
      }, timeoutMs);
      this.events.once("exit", (exit) => {
        clearTimeout(timeout);
        resolveExit(exit);
      });
    });
  }

  private push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      let line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      const frame = JSON.parse(line.toString("utf8"));
      this.frames.push(frame);
      this.events.emit("frame", frame);
    }
  }
}

export const pinnedPolicyParams = {
  sessionPolicy: {
    sessionTitle: { effort: "minimal", maxWords: 6, fallback: "heuristic" },
    compaction: { enabled: true, thresholdPercent: 90 },
    modelProfiles: [
      { name: "sol-low", provider: "openai-codex", model: "gpt-5.6-sol", effort: "low" },
    ],
  },
  policyProvenance: {},
};

export const initializeParams = (generation: number) => ({
  protocol: { minVersion: 3, maxVersion: 3 },
  workerId: `worker-${generation}`,
  runtimeGeneration: generation,
});
