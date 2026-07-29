import { readFileSync } from "node:fs";
import { BACKEND_NAMES, type BackendName } from "./domain.ts";

export const CAPABILITY_NAMES = ["researcher", "browser_user", "computer_user"] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];
export interface Capability { readonly name: CapabilityName; readonly backend: BackendName; readonly model: string; readonly effort: string; readonly allowedBackends: readonly BackendName[]; readonly instructions: string }
export interface CapabilityCatalog { readonly version: 1; readonly capabilities: readonly Capability[] }

export function parseCapabilityCatalog(input: unknown): CapabilityCatalog {
  const root = object(input, "catalog"); exact(root, ["version", "capabilities"], "catalog");
  if (root.version !== 1) throw new Error("Capability catalog version must be 1.");
  if (!Array.isArray(root.capabilities)) throw new Error("catalog.capabilities must be an array.");
  const seen = new Set<string>();
  const capabilities = root.capabilities.map((raw, index): Capability => {
    const path = `capabilities[${index}]`; const item = object(raw, path);
    exact(item, ["name", "backend", "model", "effort", "allowedBackends", "instructions"], path);
    if (!CAPABILITY_NAMES.includes(item.name as CapabilityName)) throw new Error(`${path}.name must be one of: ${CAPABILITY_NAMES.join(", ")}.`);
    const name = item.name as CapabilityName; if (seen.has(name)) throw new Error(`Duplicate capability "${name}".`); seen.add(name);
    const backend = backendName(item.backend, `${path}.backend`);
    if (!Array.isArray(item.allowedBackends) || !item.allowedBackends.length) throw new Error(`${path}.allowedBackends must be a non-empty array.`);
    const allowedBackends = item.allowedBackends.map((v, i) => backendName(v, `${path}.allowedBackends[${i}]`));
    if (!allowedBackends.includes(backend)) throw new Error(`${path}.backend must appear in allowedBackends.`);
    return Object.freeze({ name, backend, model: text(item.model, `${path}.model`), effort: text(item.effort, `${path}.effort`), allowedBackends: Object.freeze(allowedBackends), instructions: text(item.instructions, `${path}.instructions`) });
  });
  if (seen.size !== CAPABILITY_NAMES.length) throw new Error(`Capability catalog must define exactly: ${CAPABILITY_NAMES.join(", ")}.`);
  return Object.freeze({ version: 1, capabilities: Object.freeze(capabilities) });
}
export const CAPABILITY_CATALOG = parseCapabilityCatalog(JSON.parse(readFileSync(new URL("./capabilities.json", import.meta.url), "utf8")));
export const CAPABILITIES = Object.freeze(Object.fromEntries(CAPABILITY_CATALOG.capabilities.map(c => [c.name, c]))) as Readonly<Record<CapabilityName, Capability>>;
export function capabilityInstructions(capability: Capability): string { return readFileSync(new URL(`./capabilities/${capability.instructions}`, import.meta.url), "utf8").trim(); }
function object(value: unknown, path: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: readonly string[], path: string) { const expected = new Set(keys); for (const key of Object.keys(value)) if (!expected.has(key)) throw new Error(`${path}.${key} is not a supported field.`); for (const key of keys) if (!(key in value)) throw new Error(`${path}.${key} is required.`); }
function text(value: unknown, path: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string.`); return value.trim(); }
function backendName(value: unknown, path: string): BackendName { if (!BACKEND_NAMES.includes(value as BackendName)) throw new Error(`${path} must be one of: ${BACKEND_NAMES.join(", ")}.`); return value as BackendName; }
