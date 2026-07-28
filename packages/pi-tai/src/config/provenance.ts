export type ConfigLayer = "default" | "machine" | "user" | "project";

export interface FieldOrigin {
  readonly layer: ConfigLayer;
  readonly path?: string;
  readonly digest?: string;
}

export type ConfigScope = "machine" | "project" | "session";

export interface FieldDescriptor {
  readonly scope: ConfigScope;
  readonly privileged: boolean;
}

/**
 * Keyed by dotted path into ResolvedPiTaiConfig, e.g. "sessionPolicy.sessionTitle.provider".
 * A flat record rather than a nested structure so it ports directly to a Rust HashMap in
 * I13 D9 and serializes cleanly for a future `/config explain`.
 */
export type ConfigProvenance = Readonly<Record<string, FieldOrigin>>;

export const FIELD_DESCRIPTORS: Readonly<Record<string, FieldDescriptor>> = Object.freeze({
  // SessionPolicy — privileged: selects models and spends tokens
  "sessionPolicy.sessionTitle.provider": { scope: "session", privileged: true },
  "sessionPolicy.sessionTitle.model": { scope: "session", privileged: true },
  "sessionPolicy.sessionTitle.effort": { scope: "session", privileged: true },
  "sessionPolicy.sessionTitle.maxWords": { scope: "session", privileged: true },
  "sessionPolicy.sessionTitle.fallback": { scope: "session", privileged: true },
  // SessionPolicy — unprivileged: pure agent behavior
  "sessionPolicy.compaction.enabled": { scope: "session", privileged: false },
  "sessionPolicy.compaction.thresholdPercent": { scope: "session", privileged: false },
  // SessionPolicy — privileged, replaced wholesale so tracked as one field
  "sessionPolicy.modelProfiles": { scope: "session", privileged: true },
  // ClientPreferences — client-local, unprivileged
  "clientPreferences.ansiTheme.darkTheme": { scope: "project", privileged: false },
  "clientPreferences.ansiTheme.lightTheme": { scope: "project", privileged: false },
  "clientPreferences.ansiTheme.pollIntervalMs": { scope: "project", privileged: false },
  "clientPreferences.notifications.reviewFailure": { scope: "project", privileged: false },
  "clientPreferences.notifications.agentCompletion": { scope: "project", privileged: false },
  "clientPreferences.cmux.enabled": { scope: "project", privileged: false },
});
