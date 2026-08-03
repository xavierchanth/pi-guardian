import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { parseEditorCommand } from "../editor/command.ts";
import { privateChild } from "../storage/paths.ts";

export interface TaskEditorChoice {
  executable: string;
  args: readonly string[];
}

/** Resolve task editors in the policy order. VISUAL is deliberately ignored. */
export function resolveTaskEditor(
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): TaskEditorChoice | undefined {
  for (const value of [configured, env.EDITOR]) {
    const parsed = value ? parseEditorCommand(value) : undefined;
    if (parsed) return { executable: parsed.executable, args: parsed.args };
  }
  if (platform === "win32") return undefined;
  for (const executable of ["nvim", "vim", "vi"]) {
    const found = findExecutable(executable, env.PATH);
    if (found) return { executable: found, args: [] };
  }
  return undefined;
}

export interface EditTaskBodyOptions {
  runtimeRoot: string;
  taskId: string;
  revision: number;
  digest: string;
  body: string;
  editor: TaskEditorChoice;
  /** Must return the authoritative revision and digest immediately before commit. */
  current(): { revision: number; digest: string };
  commit(body: string): unknown;
}

export type TaskEditResult =
  | { status: "saved" }
  | { status: "unchanged"; tempFile: string }
  | { status: "refused" | "error"; tempFile: string; message: string };

/** External editing with an intentionally retained recovery file unless commit succeeds. */
export async function editTaskBody(options: EditTaskBodyOptions): Promise<TaskEditResult> {
  const root = privateChild(options.runtimeRoot, "task-editor");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const tempFile = join(root, `${options.taskId}-r${options.revision}-${randomUUID()}.md`);
  writeFileSync(tempFile, options.body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    const status = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
      const child = spawn(options.editor.executable, [...options.editor.args, tempFile], {
        stdio: "inherit",
        shell: false,
      });
      child.once("error", (error) => resolve({ code: null, error }));
      child.once("close", (code) => resolve({ code }));
    });
    if (status.error || status.code !== 0)
      return {
        status: "error",
        tempFile,
        message: status.error?.message ?? `Editor exited with status ${String(status.code)}`,
      };
    const bytes = readFileSync(tempFile);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (digest(body) === options.digest) return { status: "unchanged", tempFile };
    const current = options.current();
    if (current.revision !== options.revision || current.digest !== options.digest)
      return { status: "refused", tempFile, message: "Task changed while the editor was open" };
    options.commit(body);
    unlinkSync(tempFile);
    return { status: "saved" };
  } catch (error) {
    return {
      status: "error",
      tempFile,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function findExecutable(name: string, path: string | undefined): string | undefined {
  if (!path) return undefined;
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}
