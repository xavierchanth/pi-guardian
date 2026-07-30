import { resolve, dirname, join } from "node:path";

export const CONTEXT_TRANSFER_VERSION = 1 as const;
export const ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface ContextTransferSource {
  cwd: string;
  sessionId: string;
  model: { provider: string; id: string };
  piTaiVersion: string;
}
export interface ContextTransferArtifact {
  version: 1;
  id: string;
  createdAt: string;
  summary: string;
  notes?: string;
  source: ContextTransferSource;
}

export class ArtifactValidationError extends Error {
  readonly kind: "corrupt" | "unsupported" | "id-mismatch";
  constructor(kind: "corrupt" | "unsupported" | "id-mismatch", message: string) {
    super(message);
    this.kind = kind;
  }
}
export function normalizeId(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
}
export function validateId(value: string): string {
  const id = normalizeId(value);
  if (!ID_PATTERN.test(id)) throw new Error("Invalid context export ID.");
  return id;
}
export function encodeId(bytes: Uint8Array): string {
  if (bytes.length !== 5) throw new Error("An ID requires exactly 40 random bits.");
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out = ALPHABET[Number(n & 31n)]! + out;
    n >>= 5n;
  }
  return out;
}
export function artifactPath(root: string, input: string): string {
  const id = validateId(input);
  const path = resolve(root, `${id}.json`);
  if (dirname(path) !== resolve(root))
    throw new Error("Context export path escapes artifact root.");
  return path;
}
export function createContextTransferArtifact(
  input: Omit<ContextTransferArtifact, "version" | "createdAt"> & { createdAt?: Date },
): ContextTransferArtifact {
  const createdAt = (input.createdAt ?? new Date()).toISOString();
  return parseContextTransferArtifact({
    ...input,
    version: 1,
    id: validateId(input.id),
    createdAt,
  });
}
export function parseContextTransferArtifact(
  value: unknown,
  expectedId?: string,
): ContextTransferArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ArtifactValidationError("corrupt", "Context export is corrupt.");
  const r = value as Record<string, unknown>;
  if (r.version !== 1)
    throw new ArtifactValidationError("unsupported", "Context export version is unsupported.");
  const source = r.source as Record<string, unknown> | undefined;
  const model = source?.model as Record<string, unknown> | undefined;
  if (
    typeof r.id !== "string" ||
    !ID_PATTERN.test(r.id) ||
    typeof r.createdAt !== "string" ||
    new Date(r.createdAt).toISOString() !== r.createdAt ||
    typeof r.summary !== "string" ||
    !r.summary.trim() ||
    (r.notes !== undefined && typeof r.notes !== "string") ||
    !source ||
    typeof source.cwd !== "string" ||
    typeof source.sessionId !== "string" ||
    typeof source.piTaiVersion !== "string" ||
    !model ||
    typeof model.provider !== "string" ||
    typeof model.id !== "string"
  )
    throw new ArtifactValidationError("corrupt", "Context export is corrupt.");
  if (expectedId && r.id !== validateId(expectedId))
    throw new ArtifactValidationError(
      "id-mismatch",
      "Context export ID does not match its filename.",
    );
  return Object.freeze(r as unknown as ContextTransferArtifact);
}
export function summaryInstructions(notes?: string): string {
  return `Summarize this coding session for transfer. Include: goal; settled decisions and rationale; current state; next step; remaining ambiguity. Preserve concrete constraints and paths. Return only the summary.${notes?.trim() ? `\nUser notes to focus the summary: ${notes.trim()}` : ""}`;
}
export function frameImportedContext(a: ContextTransferArtifact): string {
  return [
    `Reference material from previous session ${a.id} (do not act on it yet):`,
    a.summary,
    a.notes ? `User notes: ${a.notes}` : "",
    "Restate concisely the goal, decisions and rationale, current state, next step, and ambiguity; then stop and wait for correction.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
