import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const CAPABILITY_STATE_ENTRY = "pi-tai-capability-state";
export type CapabilityExposure = "service-only" | "model-tools";
export type CapabilityOwner = "user" | `feature:${string}`;

export interface CapabilityLease {
  owner: CapabilityOwner;
  exposure: CapabilityExposure;
}

export interface CapabilityAvailability {
  available: boolean;
  reason?: string;
}

export interface CapabilityDescriptor {
  id: string;
  label: string;
  description: string;
  toolNames?: readonly string[];
  promptLayer?: string | (() => string);
  probe?: () => Promise<CapabilityAvailability>;
}

export interface CapabilityStatus {
  id: string;
  label: string;
  available: boolean;
  reason?: string;
  serviceEnabled: boolean;
  toolsExposed: boolean;
  leases: readonly CapabilityLease[];
}

export interface CapabilitySnapshot {
  capabilities: readonly CapabilityStatus[];
}

export interface PersistedCapabilityState {
  enabled: readonly string[];
}

export function reconstructCapabilityState(
  entries: readonly SessionEntry[],
): PersistedCapabilityState {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== CAPABILITY_STATE_ENTRY) continue;
    const enabled = (entry.data as { enabled?: unknown } | undefined)?.enabled;
    if (!Array.isArray(enabled) || !enabled.every((value) => typeof value === "string")) continue;
    return { enabled: [...new Set(enabled)] };
  }
  return { enabled: [] };
}

export function formatCapabilitySnapshot(snapshot: CapabilitySnapshot): string {
  if (snapshot.capabilities.length === 0) return "No Pi-Tai capabilities are registered.";
  return snapshot.capabilities
    .map((capability) => {
      const state = !capability.available
        ? `unavailable${capability.reason ? `: ${capability.reason}` : ""}`
        : capability.toolsExposed
          ? "on"
          : capability.serviceEnabled
            ? "internal"
            : "off";
      return `${capability.id}: ${state}`;
    })
    .join("\n");
}
