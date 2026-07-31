import { spawn } from "node:child_process";
import type { AbsolutePath } from "./domain.ts";

export const SUPPORTED_JJ_VERSION = "0.43.0" as const;
export const DEFAULT_JJ_TIMEOUT_MS = 30_000;
export const DEFAULT_JJ_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

export type JjAccess = "read" | "write";

export interface JjExecutionRequest {
  readonly cwd: AbsolutePath;
  readonly args: readonly string[];
  readonly access: JjAccess;
  readonly timeoutMs?: number;
  readonly outputLimitBytes?: number;
  readonly signal?: AbortSignal;
}

export type JjExecutionFailure =
  | { kind: "not_found"; binary: string }
  | { kind: "unsupported_version"; expected: string; observed: string }
  | { kind: "spawn_failed"; reason: string }
  | { kind: "exited"; exitCode: number; signal?: NodeJS.Signals }
  | { kind: "cancelled" }
  | { kind: "timed_out"; timeoutMs: number }
  | { kind: "output_limit_exceeded"; stream: "stdout" | "stderr"; limitBytes: number };

export type JjExecutionResult =
  | {
      kind: "success";
      stdout: string;
      stderr: string;
      exitCode: 0;
      durationMs: number;
    }
  | {
      kind: "failure";
      failure: JjExecutionFailure;
      stdout: string;
      stderr: string;
      durationMs: number;
    };

export type JjProbeResult =
  | { kind: "available"; binary: string; version: typeof SUPPORTED_JJ_VERSION }
  | {
      kind: "unavailable";
      failure: Extract<
        JjExecutionFailure,
        { kind: "not_found" | "spawn_failed" | "timed_out" | "cancelled" }
      >;
    }
  | {
      kind: "unsupported";
      binary: string;
      expected: typeof SUPPORTED_JJ_VERSION;
      observed: string;
    };

export interface JjExecutor {
  execute(request: JjExecutionRequest): Promise<JjExecutionResult>;
  probe(signal?: AbortSignal): Promise<JjProbeResult>;
}

export interface JjProcessExecutorOptions {
  readonly binary?: string;
  readonly requiredVersion?: typeof SUPPORTED_JJ_VERSION;
  readonly defaultTimeoutMs?: number;
  readonly defaultOutputLimitBytes?: number;
  readonly environment?: NodeJS.ProcessEnv;
}

export class JjProcessExecutor implements JjExecutor {
  private readonly binary: string;
  private readonly requiredVersion: typeof SUPPORTED_JJ_VERSION;
  private readonly defaultTimeoutMs: number;
  private readonly defaultOutputLimitBytes: number;
  private readonly environment: NodeJS.ProcessEnv;
  private probePromise?: Promise<JjProbeResult>;

  constructor(options: JjProcessExecutorOptions = {}) {
    this.binary = options.binary ?? "jj";
    this.requiredVersion = options.requiredVersion ?? SUPPORTED_JJ_VERSION;
    this.defaultTimeoutMs = positiveInteger(
      options.defaultTimeoutMs ?? DEFAULT_JJ_TIMEOUT_MS,
      "default timeout",
    );
    this.defaultOutputLimitBytes = positiveInteger(
      options.defaultOutputLimitBytes ?? DEFAULT_JJ_OUTPUT_LIMIT_BYTES,
      "default output limit",
    );
    this.environment = {
      ...(options.environment ?? process.env),
      JJ_NO_PAGER: "1",
      NO_COLOR: "1",
    };
  }

  async probe(signal?: AbortSignal): Promise<JjProbeResult> {
    if (signal) return this.performProbe(signal);
    this.probePromise ??= this.performProbe();
    return this.probePromise;
  }

  async execute(request: JjExecutionRequest): Promise<JjExecutionResult> {
    const started = performance.now();
    const probe = await this.probe(request.signal);
    if (probe.kind !== "available") {
      return {
        kind: "failure",
        failure:
          probe.kind === "unsupported"
            ? { kind: "unsupported_version", expected: probe.expected, observed: probe.observed }
            : probe.failure,
        stdout: "",
        stderr: "",
        durationMs: elapsed(started),
      };
    }
    return this.invoke(
      request.cwd,
      ["--no-pager", "--color=never", ...request.args],
      positiveInteger(request.timeoutMs ?? this.defaultTimeoutMs, "timeout"),
      positiveInteger(request.outputLimitBytes ?? this.defaultOutputLimitBytes, "output limit"),
      request.signal,
    );
  }

  private async performProbe(signal?: AbortSignal): Promise<JjProbeResult> {
    const result = await this.invoke(
      process.cwd() as AbsolutePath,
      ["--version"],
      this.defaultTimeoutMs,
      this.defaultOutputLimitBytes,
      signal,
    );
    if (result.kind === "failure") {
      if (
        result.failure.kind === "not_found" ||
        result.failure.kind === "spawn_failed" ||
        result.failure.kind === "timed_out" ||
        result.failure.kind === "cancelled"
      )
        return { kind: "unavailable", failure: result.failure };
      return {
        kind: "unavailable",
        failure: { kind: "spawn_failed", reason: renderFailure(result.failure) },
      };
    }
    const observed = (parseJjVersion(result.stdout) ?? result.stdout.trim()) || "<unparseable>";
    if (observed !== this.requiredVersion) {
      return { kind: "unsupported", binary: this.binary, expected: this.requiredVersion, observed };
    }
    return { kind: "available", binary: this.binary, version: this.requiredVersion };
  }

  private invoke(
    cwd: AbsolutePath,
    args: readonly string[],
    timeoutMs: number,
    outputLimitBytes: number,
    signal?: AbortSignal,
  ): Promise<JjExecutionResult> {
    const started = performance.now();
    if (signal?.aborted) {
      return Promise.resolve(failure({ kind: "cancelled" }, "", "", started));
    }
    return new Promise((resolve) => {
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let disposition: JjExecutionFailure | undefined;
      let settled = false;
      const child = spawn(this.binary, [...args], {
        cwd,
        env: this.environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const finish = (result: JjExecutionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const stop = (reason: JjExecutionFailure) => {
        disposition ??= reason;
        child.kill("SIGTERM");
      };
      const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
        if (disposition) return;
        const current = stream === "stdout" ? stdout : stderr;
        const nextLength = current.length + chunk.length;
        if (nextLength > outputLimitBytes) {
          const remaining = Math.max(0, outputLimitBytes - current.length);
          const bounded = Buffer.concat([current, chunk.subarray(0, remaining)]);
          if (stream === "stdout") stdout = bounded;
          else stderr = bounded;
          stop({ kind: "output_limit_exceeded", stream, limitBytes: outputLimitBytes });
          return;
        }
        if (stream === "stdout") stdout = Buffer.concat([stdout, chunk]);
        else stderr = Buffer.concat([stderr, chunk]);
      };
      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.once("error", (error: NodeJS.ErrnoException) => {
        const reason: JjExecutionFailure =
          error.code === "ENOENT"
            ? { kind: "not_found", binary: this.binary }
            : { kind: "spawn_failed", reason: error.message };
        finish(failure(reason, stdout.toString("utf8"), stderr.toString("utf8"), started));
      });
      child.once("close", (code, closeSignal) => {
        const out = stdout.toString("utf8");
        const err = stderr.toString("utf8");
        if (disposition) return finish(failure(disposition, out, err, started));
        if (code === 0)
          return finish({
            kind: "success",
            stdout: out,
            stderr: err,
            exitCode: 0,
            durationMs: elapsed(started),
          });
        return finish(
          failure(
            {
              kind: "exited",
              exitCode: code ?? 1,
              ...(closeSignal ? { signal: closeSignal } : {}),
            },
            out,
            err,
            started,
          ),
        );
      });
      const onAbort = () => stop({ kind: "cancelled" });
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => stop({ kind: "timed_out", timeoutMs }), timeoutMs);
    });
  }
}

export type JjExecutionScript = (request: JjExecutionRequest) => Promise<JjExecutionResult>;

export class ScriptedJjExecutor implements JjExecutor {
  readonly requests: JjExecutionRequest[] = [];
  private readonly script: JjExecutionScript;
  private readonly probeResult: JjProbeResult;

  constructor(
    script: JjExecutionScript,
    probeResult: JjProbeResult = { kind: "available", binary: "jj", version: SUPPORTED_JJ_VERSION },
  ) {
    this.script = script;
    this.probeResult = probeResult;
  }

  probe(): Promise<JjProbeResult> {
    return Promise.resolve(this.probeResult);
  }

  execute(request: JjExecutionRequest): Promise<JjExecutionResult> {
    this.requests.push(request);
    return this.script(request);
  }
}

export function jjSuccess(stdout = "", stderr = ""): JjExecutionResult {
  return { kind: "success", stdout, stderr, exitCode: 0, durationMs: 0 };
}

export function renderJjExecutionFailure(failure: JjExecutionFailure): string {
  return renderFailure(failure);
}

function failure(
  reason: JjExecutionFailure,
  stdout: string,
  stderr: string,
  started: number,
): JjExecutionResult {
  return { kind: "failure", failure: reason, stdout, stderr, durationMs: elapsed(started) };
}

function elapsed(started: number): number {
  return Math.max(0, performance.now() - started);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`JJ ${label} must be a positive integer.`);
  return value;
}

function parseJjVersion(output: string): string | undefined {
  return /^jj\s+(\d+\.\d+\.\d+)(?:[-+\s]|$)/.exec(output.trim())?.[1];
}

function renderFailure(value: JjExecutionFailure): string {
  switch (value.kind) {
    case "not_found":
      return `JJ binary not found: ${value.binary}`;
    case "unsupported_version":
      return `Unsupported JJ version ${value.observed}; expected ${value.expected}.`;
    case "spawn_failed":
      return `JJ process failed to start: ${value.reason}`;
    case "exited":
      return `JJ exited with status ${value.exitCode}${value.signal ? ` (${value.signal})` : ""}.`;
    case "cancelled":
      return "JJ execution was cancelled.";
    case "timed_out":
      return `JJ execution timed out after ${value.timeoutMs}ms.`;
    case "output_limit_exceeded":
      return `JJ ${value.stream} exceeded ${value.limitBytes} bytes.`;
  }
}
