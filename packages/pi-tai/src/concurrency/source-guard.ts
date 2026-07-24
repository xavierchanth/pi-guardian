import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SourceWorkspaceHandle } from "../jj/domain.ts";
import type { SharedFileSetCoordinator } from "./file-sets.ts";

export interface SharedMutationGuardState {
  readonly enabled: boolean;
  readonly ownerContextId?: string;
  readonly constrainShell?: boolean;
}

export interface SharedMutationGuardOptions {
  readonly openSource: (cwd: string) => Promise<SourceWorkspaceHandle>;
  readonly fileSets: SharedFileSetCoordinator;
  readonly state: () => SharedMutationGuardState;
}

interface AuthorizedMutation {
  readonly source: SourceWorkspaceHandle;
  readonly ownerContextId: string;
  readonly path: string;
}

export function registerSharedMutationGuard(pi: ExtensionAPI, options: SharedMutationGuardOptions): void {
  const authorized = new Map<string, AuthorizedMutation>();
  const sources = new Map<string, Promise<SourceWorkspaceHandle>>();
  const sourceFor = (cwd: string) => {
    let source = sources.get(cwd);
    if (!source) {
      source = options.openSource(cwd);
      sources.set(cwd, source);
    }
    return source;
  };

  pi.on("tool_call", async (event, ctx) => {
    const state = options.state();
    if (!state.enabled) return undefined;
    if (event.toolName === "write" || event.toolName === "edit") {
      const path = typeof event.input.path === "string" ? event.input.path : undefined;
      if (!path) return { block: true, reason: "Shared source mutation requires a concrete file path." };
      try {
        const source = await sourceFor(ctx.cwd);
        if (state.ownerContextId) {
          await options.fileSets.authorizePath(source, state.ownerContextId, path);
          authorized.set(event.toolCallId, { source, ownerContextId: state.ownerContextId, path });
        } else {
          await options.fileSets.authorizeUnclaimedPath(source, path);
        }
        return undefined;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (reason.includes("requires the repository's primary JJ workspace")) return undefined;
        return { block: true, reason };
      }
    }
    if (event.toolName === "bash" && state.constrainShell) {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      const decision = classifySharedShellCommand(command);
      if (decision.kind !== "allowed") {
        return { block: true, reason: decision.reason };
      }
    }
    return undefined;
  });

  pi.on("tool_result", async (event) => {
    const mutation = authorized.get(event.toolCallId);
    if (!mutation) return undefined;
    authorized.delete(event.toolCallId);
    if (!event.isError) {
      await options.fileSets.recordOwnedMutation(mutation.source, mutation.ownerContextId, mutation.path);
    }
    return undefined;
  });
}

export type SharedShellDecision =
  | { readonly kind: "allowed"; readonly purpose: "read" | "validation" }
  | { readonly kind: "blocked"; readonly reason: string };

export function classifySharedShellCommand(command: string): SharedShellDecision {
  const normalized = command.trim();
  if (!normalized) return { kind: "blocked", reason: "Empty shared-worker shell command." };
  if (/(^|[^<])>{1,2}|<\(|>\(|`|\$\(/.test(normalized)) {
    return { kind: "blocked", reason: "Shared-worker shell redirection or command substitution may mutate source files." };
  }
  const segments = normalized.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean);
  let validation = false;
  for (const raw of segments) {
    const segment = raw.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*/, "").trim();
    if (!segment) continue;
    const words = shellWords(segment);
    const executable = basename(words[0] ?? "");
    if (["rm", "mv", "cp", "mkdir", "rmdir", "touch", "truncate", "chmod", "chown", "ln", "tee", "patch", "apply_patch", "sed", "perl", "python", "python3", "ruby"].includes(executable)) {
      return { kind: "blocked", reason: `Shared-worker shell command ${executable} can mutate source files; use guarded file tools.` };
    }
    if (executable === "jj") {
      if (!isReadOnlyJj(words.slice(1))) {
        return { kind: "blocked", reason: "Shared workers may not mutate JJ through bash; use deterministic JJ tools." };
      }
      continue;
    }
    if (executable === "git") {
      if (!["diff", "status", "show", "log"].includes(words[1] ?? "")) {
        return { kind: "blocked", reason: "Shared workers may use Git through bash only for read-only inspection." };
      }
      continue;
    }
    if (["rg", "grep", "ls", "pwd", "wc", "head", "tail", "diff", "stat", "file", "which", "command", "printf"].includes(executable)) {
      if (executable === "grep" && words.includes("--include")) continue;
      continue;
    }
    if (executable === "find") {
      if (words.some((word) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(word))) {
        return { kind: "blocked", reason: "Mutating find actions are unavailable to shared workers." };
      }
      continue;
    }
    if (isValidationCommand(executable, words.slice(1))) {
      validation = true;
      continue;
    }
    return { kind: "blocked", reason: `Shared-worker shell command ${executable || "<unknown>"} is not an approved read or validation command.` };
  }
  return { kind: "allowed", purpose: validation ? "validation" : "read" };
}

function isReadOnlyJj(args: readonly string[]): boolean {
  const command = args.find((value) => !value.startsWith("-"));
  if (!command) return false;
  if (["status", "diff", "log", "show", "root"].includes(command)) return true;
  if (command === "file") return args.includes("list") || args.includes("show");
  if (command === "workspace") return args.includes("list") || args.includes("root");
  if (command === "operation" || command === "op") return args.includes("log") || args.includes("show");
  if (command === "config") return args.includes("get") || args.includes("list");
  if (command === "resolve") return args.includes("--list");
  return false;
}

function isValidationCommand(executable: string, args: readonly string[]): boolean {
  if (["tsc", "eslint", "biome", "vitest", "jest", "pytest", "cargo", "go"].includes(executable)) {
    if (args.some((arg) => /^(?:--fix|-w|fmt|format|generate)$/.test(arg))) return false;
    if (executable === "cargo") return ["test", "check", "clippy"].includes(args[0] ?? "");
    if (executable === "go") return args[0] === "test";
    return true;
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
    const text = args.join(" ").toLowerCase();
    if (/\b(fix|format|fmt|write|generate|update)\b/.test(text)) return false;
    return /^(?:test|run\s+(?:test|typecheck|check|lint|build)\b)/.test(text);
  }
  if (executable === "node") return args[0] === "--test" || args.some((arg) => arg.includes("test"));
  return false;
}

function shellWords(segment: string): string[] {
  return segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((word) => word.replace(/^(['"])(.*)\1$/, "$2")) ?? [];
}
function basename(value: string): string { return value.replaceAll("\\", "/").split("/").at(-1) ?? value; }
