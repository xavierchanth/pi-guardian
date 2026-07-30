import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  reconstructCapabilityState,
  type CapabilityDescriptor,
  type CapabilityLease,
  type CapabilityOwner,
  type CapabilitySnapshot,
  type CapabilityStatus,
} from "./domain.ts";

export interface CapabilityToolBinding {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

export class SessionCapabilityController {
  private readonly descriptors = new Map<string, CapabilityDescriptor>();
  private readonly leases = new Map<string, Map<CapabilityOwner, CapabilityLease>>();
  private readonly availability = new Map<string, { available: boolean; reason?: string }>();
  private readonly suppressedTools = new Set<string>();
  private binding?: CapabilityToolBinding;
  private persist?: (enabled: readonly string[]) => void;

  bindTools(binding: CapabilityToolBinding): void {
    this.binding = binding;
  }

  bindPersistence(persist: (enabled: readonly string[]) => void): void {
    this.persist = persist;
  }

  register(descriptor: CapabilityDescriptor): void {
    if (this.descriptors.has(descriptor.id))
      throw new Error(`Capability already registered: ${descriptor.id}`);
    this.descriptors.set(descriptor.id, descriptor);
    this.availability.set(descriptor.id, { available: true });
  }

  async probe(id: string): Promise<CapabilityStatus> {
    const descriptor = this.requireDescriptor(id);
    const availability = descriptor.probe ? await descriptor.probe() : { available: true };
    this.availability.set(id, availability);
    return this.status(id);
  }

  async enable(id: string, lease: CapabilityLease): Promise<CapabilityStatus> {
    const descriptor = this.requireDescriptor(id);
    const availability = descriptor.probe ? await descriptor.probe() : { available: true };
    this.availability.set(id, availability);
    if (!availability.available) {
      throw new Error(
        `Capability ${id} is unavailable${availability.reason ? `: ${availability.reason}` : "."}`,
      );
    }
    const leases = this.leases.get(id) ?? new Map<CapabilityOwner, CapabilityLease>();
    leases.set(lease.owner, { ...lease });
    this.leases.set(id, leases);
    this.syncTools();
    if (lease.owner === "user") this.persistUserState();
    return this.status(id);
  }

  disable(id: string, owner: CapabilityOwner): CapabilityStatus {
    this.requireDescriptor(id);
    const leases = this.leases.get(id);
    leases?.delete(owner);
    if (leases?.size === 0) this.leases.delete(id);
    this.syncTools();
    if (owner === "user") this.persistUserState();
    return this.status(id);
  }

  reconstruct(entries: readonly SessionEntry[], reset: boolean): void {
    for (const [id, leases] of this.leases) {
      leases.delete("user");
      if (leases.size === 0) this.leases.delete(id);
    }
    if (!reset) {
      for (const id of reconstructCapabilityState(entries).enabled) {
        if (!this.descriptors.has(id)) continue;
        const leases = this.leases.get(id) ?? new Map<CapabilityOwner, CapabilityLease>();
        leases.set("user", { owner: "user", exposure: "model-tools" });
        this.leases.set(id, leases);
      }
    }
    this.syncTools();
  }

  status(id: string): CapabilityStatus {
    const descriptor = this.requireDescriptor(id);
    const leases = [...(this.leases.get(id)?.values() ?? [])];
    const availability = this.availability.get(id) ?? { available: true };
    return {
      id,
      label: descriptor.label,
      available: availability.available,
      ...(availability.reason ? { reason: availability.reason } : {}),
      serviceEnabled: leases.length > 0,
      toolsExposed:
        !this.suppressedTools.has(id) && leases.some((lease) => lease.exposure === "model-tools"),
      leases: leases.map((lease) => ({ ...lease })),
    };
  }

  snapshot(): CapabilitySnapshot {
    return {
      capabilities: [...this.descriptors.keys()].sort().map((id) => this.status(id)),
    };
  }

  suppressTools(ids: readonly string[], suppressed: boolean): void {
    for (const id of ids) {
      if (suppressed) this.suppressedTools.add(id);
      else this.suppressedTools.delete(id);
    }
    this.syncTools();
  }

  isServiceEnabled(id: string): boolean {
    return this.status(id).serviceEnabled;
  }

  isToolExposed(id: string): boolean {
    const leases = [...(this.leases.get(id)?.values() ?? [])];
    return (
      !this.suppressedTools.has(id) && leases.some((lease) => lease.exposure === "model-tools")
    );
  }

  promptLayers(): string[] {
    const layers: string[] = [];
    for (const [id, descriptor] of this.descriptors) {
      if (!this.isToolExposed(id) || !descriptor.promptLayer) continue;
      const layer =
        typeof descriptor.promptLayer === "function"
          ? descriptor.promptLayer()
          : descriptor.promptLayer;
      if (layer.trim()) layers.push(layer.trim());
    }
    return layers;
  }

  private requireDescriptor(id: string): CapabilityDescriptor {
    const descriptor = this.descriptors.get(id);
    if (!descriptor) throw new Error(`Unknown capability: ${id}`);
    return descriptor;
  }

  private persistUserState(): void {
    const enabled = [...this.leases]
      .filter(([, leases]) => leases.has("user"))
      .map(([id]) => id)
      .sort();
    this.persist?.(enabled);
  }

  private syncTools(): void {
    if (!this.binding) return;
    const managed = new Set<string>();
    for (const descriptor of this.descriptors.values()) {
      for (const name of descriptor.toolNames ?? []) managed.add(name);
    }
    const next = this.binding.getActiveTools().filter((name) => !managed.has(name));
    for (const [id, descriptor] of this.descriptors) {
      if (!this.isToolExposed(id)) continue;
      next.push(...(descriptor.toolNames ?? []));
    }
    this.binding.setActiveTools([...new Set(next)]);
  }
}
