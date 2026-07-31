import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PROFILE_CYCLE_SHORTCUT = "shift+tab";
export const THINKING_CYCLE_SHORTCUT = "ctrl+alt+t";
export const THINKING_CYCLE_KEYBINDING = "app.thinking.cycle";

export interface ProvisionKeybindingsResult {
  changed: boolean;
  path: string;
  warning?: string;
}

export function registerFirstPartyKeybindings(pi: ExtensionAPI, agentDir: string): void {
  const result = provisionFirstPartyKeybindings(agentDir);
  if (!result.warning) return;

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(result.warning!, "warning");
  });
}

export function provisionFirstPartyKeybindings(agentDir: string): ProvisionKeybindingsResult {
  const path = join(agentDir, "keybindings.json");
  const loaded = readKeybindings(path);
  if (loaded.warning) return { changed: false, path, warning: loaded.warning };

  const keybindings = loaded.keybindings;
  const configured = normalizeKeys(keybindings[THINKING_CYCLE_KEYBINDING]);
  const next = configured
    .filter((key) => key.toLowerCase() !== PROFILE_CYCLE_SHORTCUT)
    .filter(
      (key, index, keys) =>
        keys.findIndex((entry) => entry.toLowerCase() === key.toLowerCase()) === index,
    );
  if (!next.some((key) => key.toLowerCase() === THINKING_CYCLE_SHORTCUT)) {
    next.push(THINKING_CYCLE_SHORTCUT);
  }

  if (sameKeys(configured, next)) return { changed: false, path };

  const updated = {
    ...keybindings,
    [THINKING_CYCLE_KEYBINDING]: next,
  };
  try {
    writeJsonAtomically(path, updated);
    return { changed: true, path };
  } catch (error) {
    return {
      changed: false,
      path,
      warning: `Pi-Tai could not configure first-party keybindings in ${path}: ${errorMessage(error)}`,
    };
  }
}

function readKeybindings(path: string): {
  keybindings: Record<string, unknown>;
  warning?: string;
} {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { keybindings: {} };
    return {
      keybindings: {},
      warning: `Pi-Tai could not read ${path}: ${errorMessage(error)}`,
    };
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      return {
        keybindings: {},
        warning: `Pi-Tai did not modify ${path}: expected a JSON object.`,
      };
    }
    return { keybindings: parsed };
  } catch (error) {
    return {
      keybindings: {},
      warning: `Pi-Tai did not modify invalid JSON in ${path}: ${errorMessage(error)}`,
    };
  }
}

function normalizeKeys(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value;
  }
  return [];
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function writeJsonAtomically(path: string, value: Record<string, unknown>): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
