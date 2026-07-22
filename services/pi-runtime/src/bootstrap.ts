import { createDiagnosticSink, installConsoleRedirect } from "./diagnostics.ts";

const stdoutWrite = process.stdout.write.bind(process.stdout);
const protocolOutput = {
  write(chunk: string): boolean {
    return stdoutWrite(chunk, "utf8");
  },
  once(event: "drain", listener: () => void) {
    return process.stdout.once(event, listener);
  },
};
const diagnostics = createDiagnosticSink();
installConsoleRedirect(diagnostics);

const guardedWrite = (() => {
  throw new Error("Direct stdout writes are forbidden; use the runtime JSONL transport.");
}) as typeof process.stdout.write;
process.stdout.write = guardedWrite;

async function bootstrap(): Promise<void> {
  try {
    const { runWorker } = await import("./main.ts");
    await runWorker({ output: protocolOutput, diagnostics });
  } catch (error) {
    diagnostics({
      timestamp: new Date().toISOString(),
      level: "error",
      event: "runtime_fatal",
      data: { error: error instanceof Error ? error.name : "unknown" },
    });
    process.exitCode = 1;
  }
}

void bootstrap();
