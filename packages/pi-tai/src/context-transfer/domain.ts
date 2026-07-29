export const CONTEXT_TRANSFER_VERSION = 1 as const;

export interface ContextTransferArtifact {
  version: typeof CONTEXT_TRANSFER_VERSION;
  id: string;
  createdAt: string;
  summary: string;
}

export function createContextTransferArtifact(id: string, summary: string, now = new Date()): ContextTransferArtifact {
  const normalizedId = id.trim();
  const normalizedSummary = summary.trim();
  if (!/^[a-z0-9][a-z0-9-]{5,63}$/i.test(normalizedId)) throw new Error("Invalid context-transfer ID.");
  if (!normalizedSummary) throw new Error("Context-transfer summary must not be empty.");
  return Object.freeze({ version: CONTEXT_TRANSFER_VERSION, id: normalizedId, createdAt: now.toISOString(), summary: normalizedSummary });
}

export function parseContextTransferArtifact(value: unknown): ContextTransferArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid context-transfer artifact.");
  const record = value as Record<string, unknown>;
  if (record.version !== CONTEXT_TRANSFER_VERSION || typeof record.id !== "string" || typeof record.createdAt !== "string" || typeof record.summary !== "string") throw new Error("Invalid context-transfer artifact.");
  const artifact = createContextTransferArtifact(record.id, record.summary, new Date(record.createdAt));
  if (Number.isNaN(Date.parse(artifact.createdAt))) throw new Error("Invalid context-transfer timestamp.");
  return artifact;
}

export function frameImportedContext(artifact: ContextTransferArtifact): string {
  return [
    `<context-transfer id="${artifact.id}" version="${artifact.version}">`,
    artifact.summary,
    "</context-transfer>",
    "Treat the framed context as durable background for this session. Concisely reiterate the goal, decisions and rationale, current state, next step, and any ambiguities; then wait for the user.",
  ].join("\n");
}
