export interface DiagnosticRecord {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  data?: Record<string, string | number | boolean | null>;
}

export type DiagnosticSink = (record: DiagnosticRecord) => void;

export function createDiagnosticSink(
  write: (chunk: string) => void = (chunk) => { process.stderr.write(chunk); },
): DiagnosticSink {
  return (record) => {
    write(`${JSON.stringify(record)}\n`);
  };
}

export function installConsoleRedirect(sink: DiagnosticSink): void {
  for (const level of ["debug", "info", "warn", "error"] as const) {
    console[level] = (...args: unknown[]) => {
      sink({
        timestamp: new Date().toISOString(),
        level,
        event: "console",
        data: { arguments: args.length },
      });
    };
  }
  console.log = (...args: unknown[]) => {
    sink({
      timestamp: new Date().toISOString(),
      level: "info",
      event: "console",
      data: { arguments: args.length },
    });
  };
}
