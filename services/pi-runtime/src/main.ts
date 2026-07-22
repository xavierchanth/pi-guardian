import type { Writable } from "node:stream";
import { createDiagnosticSink } from "./diagnostics.ts";
import { FakeRuntimePort } from "./fake-runtime.ts";
import { JsonlReader, JsonlWriter } from "./jsonl.ts";
import { PiSdkRuntimePort } from "./pi-runtime.ts";
import type { RuntimePort } from "./runtime-port.ts";
import { RuntimeWorker } from "./worker.ts";

export interface WorkerMainOptions {
  output: Writable | { write(chunk: string): boolean; once(event: "drain", listener: () => void): unknown };
  input?: NodeJS.ReadableStream;
  port?: RuntimePort;
  diagnostics?: ReturnType<typeof createDiagnosticSink>;
}

export async function runWorker(options: WorkerMainOptions): Promise<void> {
  const diagnostics = options.diagnostics ?? createDiagnosticSink();
  if (process.env.PI_TAI_RUNTIME_TEST_CONSOLE === "1") {
    console.log("stdout contamination probe");
  }
  const writer = new JsonlWriter(options.output);
  const port = options.port
    ?? (process.env.PI_TAI_RUNTIME_FAKE_PORT === "1" ? new FakeRuntimePort() : new PiSdkRuntimePort(diagnostics));
  const worker = new RuntimeWorker(port, writer, diagnostics);
  const input = options.input ?? process.stdin;
  let stopping = false;
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const reader = new JsonlReader({
    async onValue(value) {
      await worker.handleValue(value);
      if (worker.currentState() === "stopped") {
        stopping = true;
        input.pause();
        resolveDone();
      }
    },
    onMalformed: (reason) => worker.handleMalformed(reason),
  });

  const onData = (chunk: Buffer | string) => reader.push(chunk);
  const onEnd = () => {
    void reader.end().then(resolveDone, rejectDone);
  };
  const onError = (error: unknown) => rejectDone(error);
  input.on("data", onData);
  input.once("end", onEnd);
  input.once("error", onError);

  let signals = 0;
  const onSignal = () => {
    signals += 1;
    if (signals > 1) {
      process.exitCode = 1;
      resolveDone();
      return;
    }
    stopping = true;
    input.pause();
    void worker.stop().then(resolveDone, rejectDone);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  try {
    await done;
    if (!stopping) await worker.stop();
    await writer.flush();
  } finally {
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("error", onError);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}
