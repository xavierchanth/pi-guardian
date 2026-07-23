import { readFileSync } from "node:fs";
import { piTaiConfigPaths } from "./paths.ts";
import {
  THINKING_EFFORTS,
  type ModelProfile,
  type ThinkingEffort,
} from "../model-profiles/domain.ts";
import {
  DEFAULT_PI_TAI_CONFIG,
  TITLE_EFFORTS,
  type AnsiThemeConfig,
  type CompactionConfig,
  type NotificationsConfig,
  type PiTaiConfig,
  type SessionTitleConfig,
  type TitleEffort,
} from "./schema.ts";

interface PartialPiTaiConfig {
  sessionTitle?: Partial<SessionTitleConfig>;
  ansiTheme?: Partial<AnsiThemeConfig>;
  notifications?: Partial<NotificationsConfig>;
  compaction?: Partial<CompactionConfig>;
  modelProfiles?: ModelProfile[];
}

export interface LoadPiTaiConfigOptions {
  cwd: string;
  projectTrusted: boolean;
  agentDir?: string;
}

export interface LoadedPiTaiConfig {
  config: PiTaiConfig;
  warnings: string[];
  globalPath: string;
  projectPath: string;
}

export function loadPiTaiConfig(options: LoadPiTaiConfigOptions): LoadedPiTaiConfig {
  const paths = piTaiConfigPaths(options.cwd, options.agentDir);
  const warnings: string[] = [];
  const global = readConfig(paths.global, warnings);
  const project = options.projectTrusted
    ? readConfig(paths.project, warnings)
    : {};

  const config: PiTaiConfig = Object.freeze({
    sessionTitle: Object.freeze({
      ...DEFAULT_PI_TAI_CONFIG.sessionTitle,
      ...global.sessionTitle,
      ...project.sessionTitle,
    }),
    ansiTheme: Object.freeze({
      ...DEFAULT_PI_TAI_CONFIG.ansiTheme,
      ...global.ansiTheme,
      ...project.ansiTheme,
    }),
    notifications: Object.freeze({
      ...DEFAULT_PI_TAI_CONFIG.notifications,
      ...global.notifications,
      ...project.notifications,
    }),
    compaction: Object.freeze({
      ...DEFAULT_PI_TAI_CONFIG.compaction,
      ...global.compaction,
      ...project.compaction,
    }),
    modelProfiles: Object.freeze(
      project.modelProfiles ?? global.modelProfiles ?? DEFAULT_PI_TAI_CONFIG.modelProfiles,
    ),
  });

  return {
    config,
    warnings,
    globalPath: paths.global,
    projectPath: paths.project,
  };
}

function readConfig(path: string, warnings: string[]): PartialPiTaiConfig {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    warnings.push(`Invalid or unreadable ${path}: ${errorMessage(error)}`);
    return {};
  }

  if (!isRecord(value)) {
    warnings.push(`Invalid ${path}: expected a JSON object.`);
    return {};
  }

  for (const key of Object.keys(value)) {
    if (key !== "sessionTitle" && key !== "ansiTheme" && key !== "notifications" && key !== "compaction" && key !== "modelProfiles") {
      warnings.push(`Unknown top-level key ${key} in ${path}.`);
    }
  }

  return {
    sessionTitle: parseSessionTitle(value.sessionTitle, path, warnings),
    ansiTheme: parseAnsiTheme(value.ansiTheme, path, warnings),
    notifications: parseNotifications(value.notifications, path, warnings),
    compaction: parseCompaction(value.compaction, path, warnings),
    modelProfiles: parseModelProfiles(value.modelProfiles, path, warnings),
  };
}

function parseSessionTitle(
  value: unknown,
  path: string,
  warnings: string[],
): Partial<SessionTitleConfig> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    warnings.push(`Invalid sessionTitle in ${path}: expected an object.`);
    return undefined;
  }

  warnUnknown(value, new Set(["provider", "model", "effort", "maxWords", "fallback"]), "sessionTitle", path, warnings);
  const result: Partial<SessionTitleConfig> = {};
  assignNonEmptyString(value, "provider", result, path, warnings);
  assignNonEmptyString(value, "model", result, path, warnings);

  if (value.effort !== undefined) {
    if (typeof value.effort === "string" && TITLE_EFFORTS.includes(value.effort as TitleEffort)) {
      result.effort = value.effort as TitleEffort;
    } else {
      warnings.push(`Invalid sessionTitle.effort in ${path}.`);
    }
  }
  if (value.maxWords !== undefined) {
    if (Number.isInteger(value.maxWords) && (value.maxWords as number) >= 1 && (value.maxWords as number) <= 20) {
      result.maxWords = value.maxWords as number;
    } else {
      warnings.push(`Invalid sessionTitle.maxWords in ${path}: expected an integer from 1 to 20.`);
    }
  }
  if (value.fallback !== undefined) {
    if (value.fallback === "heuristic") result.fallback = "heuristic";
    else warnings.push(`Invalid sessionTitle.fallback in ${path}: expected heuristic.`);
  }
  return result;
}

function parseAnsiTheme(
  value: unknown,
  path: string,
  warnings: string[],
): Partial<AnsiThemeConfig> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    warnings.push(`Invalid ansiTheme in ${path}: expected an object.`);
    return undefined;
  }

  warnUnknown(value, new Set(["darkTheme", "lightTheme", "pollIntervalMs"]), "ansiTheme", path, warnings);
  const result: Partial<AnsiThemeConfig> = {};
  assignNonEmptyString(value, "darkTheme", result, path, warnings);
  assignNonEmptyString(value, "lightTheme", result, path, warnings);
  if (value.pollIntervalMs !== undefined) {
    if (Number.isInteger(value.pollIntervalMs) && (value.pollIntervalMs as number) >= 250 && (value.pollIntervalMs as number) <= 60_000) {
      result.pollIntervalMs = value.pollIntervalMs as number;
    } else {
      warnings.push(`Invalid ansiTheme.pollIntervalMs in ${path}: expected an integer from 250 to 60000.`);
    }
  }
  return result;
}

function parseNotifications(
  value: unknown,
  path: string,
  warnings: string[],
): Partial<NotificationsConfig> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    warnings.push(`Invalid notifications in ${path}: expected an object.`);
    return undefined;
  }

  warnUnknown(
    value,
    new Set(["reviewFailure", "agentCompletion"]),
    "notifications",
    path,
    warnings,
  );
  const result: Partial<NotificationsConfig> = {};
  for (const key of ["reviewFailure", "agentCompletion"] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] === "boolean") result[key] = value[key];
    else warnings.push(`Invalid notifications.${key} in ${path}: expected a boolean.`);
  }
  return result;
}

function parseCompaction(
  value: unknown,
  path: string,
  warnings: string[],
): Partial<CompactionConfig> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    warnings.push(`Invalid compaction in ${path}: expected an object.`);
    return undefined;
  }

  warnUnknown(value, new Set(["enabled", "thresholdPercent"]), "compaction", path, warnings);
  const result: Partial<CompactionConfig> = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled === "boolean") result.enabled = value.enabled;
    else warnings.push(`Invalid compaction.enabled in ${path}: expected a boolean.`);
  }
  if (value.thresholdPercent !== undefined) {
    if (
      typeof value.thresholdPercent === "number"
      && Number.isFinite(value.thresholdPercent)
      && value.thresholdPercent >= 1
      && value.thresholdPercent <= 100
    ) {
      result.thresholdPercent = value.thresholdPercent;
    } else {
      warnings.push(`Invalid compaction.thresholdPercent in ${path}: expected a number from 1 to 100.`);
    }
  }
  return result;
}

function parseModelProfiles(
  value: unknown,
  path: string,
  warnings: string[],
): ModelProfile[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    warnings.push(`Invalid modelProfiles in ${path}: expected an array.`);
    return undefined;
  }
  const profiles: ModelProfile[] = [];
  const names = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const entry = value[index];
    if (!isRecord(entry)) {
      warnings.push(`Invalid modelProfiles[${index}] in ${path}: expected an object.`);
      return undefined;
    }
    warnUnknown(entry, new Set(["name", "provider", "model", "effort"]), `modelProfiles[${index}]`, path, warnings);
    const name = profileString(entry.name);
    const provider = profileString(entry.provider);
    const model = profileString(entry.model);
    const effort = entry.effort;
    if (!name || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
      warnings.push(`Invalid modelProfiles[${index}].name in ${path}.`);
      return undefined;
    }
    if (names.has(name)) {
      warnings.push(`Duplicate model profile "${name}" in ${path}.`);
      return undefined;
    }
    if (!provider || !model) {
      warnings.push(`Invalid modelProfiles[${index}] model in ${path}.`);
      return undefined;
    }
    if (typeof effort !== "string" || !THINKING_EFFORTS.includes(effort as ThinkingEffort)) {
      warnings.push(`Invalid modelProfiles[${index}].effort in ${path}.`);
      return undefined;
    }
    names.add(name);
    profiles.push(Object.freeze({ name, provider, model, effort: effort as ThinkingEffort }));
  }
  return profiles;
}

function profileString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function assignNonEmptyString<T extends object>(
  source: Record<string, unknown>,
  key: string,
  target: T,
  path: string,
  warnings: string[],
): void {
  const value = source[key];
  if (value === undefined) return;
  if (typeof value === "string" && value.trim()) {
    (target as Record<string, unknown>)[key] = value.trim();
    return;
  }
  warnings.push(`Invalid ${key} in ${path}: expected a non-empty string.`);
}

function warnUnknown(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string,
  path: string,
  warnings: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) warnings.push(`Unknown ${prefix}.${key} in ${path}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
