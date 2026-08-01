import { tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

const CLIPBOARD_IMAGE =
  /(?:^|[\s"'(<])((?:\/[^\s"'<>)]*)?\/pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpe?g|gif|webp|bmp))(?=$|[\s"'`>,;:)])/giu;

export const TEMPORARY_IMAGE_ERROR =
  "Subagents cannot receive temporary image attachments yet. Describe the image in text or save it to a stable user-authorized project path.";

/**
 * This is deliberately lexical: inspecting or resolving an attacker-controlled
 * path would follow symlinks and introduce a TOCTOU authorization mistake. The
 * path is rejected only when its normalized spelling is beneath a trusted temp
 * root; no file is opened and no path is authorized by this check.
 */
export function containsTemporaryClipboardImage(
  values: readonly string[],
  tempRoots: readonly string[] = trustedTempRoots(),
  stableRoots: readonly string[] = [],
): boolean {
  const roots = tempRoots.map(canonicalSpelling);
  const stable = stableRoots.map(canonicalSpelling);
  for (const value of values) {
    CLIPBOARD_IMAGE.lastIndex = 0;
    for (const match of value.matchAll(CLIPBOARD_IMAGE)) {
      const candidate = match[1];
      if (!candidate || !isAbsolute(candidate)) continue;
      const normalized = canonicalSpelling(candidate);
      if (stable.some((root) => normalized === root || normalized.startsWith(`${root}${sep}`))) {
        continue;
      }
      if (roots.some((root) => normalized.startsWith(`${root}${sep}`))) return true;
    }
  }
  return false;
}

function trustedTempRoots(): string[] {
  // /var and /tmp are symlinked to /private on macOS. Include both spellings;
  // canonicalSpelling folds them without touching the filesystem.
  return [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
}

function canonicalSpelling(path: string): string {
  const normalized = resolve(path);
  if (normalized === "/tmp" || normalized.startsWith("/tmp/")) return `/private${normalized}`;
  if (normalized === "/var" || normalized.startsWith("/var/")) return `/private${normalized}`;
  return normalized;
}
