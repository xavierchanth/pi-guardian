/**
 * `jj workspace update-stale` is data-displacing, not data-losing. When the stale working
 * copy holds uncommitted work, jj snapshots it into a divergent sibling commit and then
 * checks out the other side. The files disappear from disk and the only clue in the command
 * output is an ordinary "Added N files, modified N files, removed N files" line.
 *
 * Every managed call therefore samples `divergent()` on both sides of the update and refuses
 * to continue when a new divergent change appears, naming the exact Change IDs so the work
 * stays recoverable instead of orphaned.
 */

/** Truly read-only: verified to publish no operation of its own. */
export const DIVERGENT_ARGV = [
  "--at-op=@",
  "--ignore-working-copy",
  "log",
  "--revision",
  "divergent()",
  "--no-graph",
  "--template",
  'change_id ++ "\\n"',
] as const;

export interface StaleUpdateOutcome {
  readonly output: string;
  readonly displacedChangeIds: readonly string[];
}

export function parseChangeIds(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function displacedChangeIds(before: readonly string[], after: readonly string[]): string[] {
  const known = new Set(before);
  return after.filter((id) => !known.has(id)).sort();
}

/**
 * Runs `jj workspace update-stale` with displacement detection.
 *
 * `read` must be a non-mutating executor; `run` performs the update itself.
 * Throws when the update created recovery history or displaced uncommitted work.
 */
export async function updateStaleSafely(options: {
  readonly context: string;
  readonly location: string;
  readonly read: (args: readonly string[]) => Promise<string>;
  readonly run: (args: readonly string[]) => Promise<string>;
}): Promise<StaleUpdateOutcome> {
  const before = parseChangeIds(await options.read(DIVERGENT_ARGV));
  const output = await options.run(["workspace", "update-stale"]);
  const after = parseChangeIds(await options.read(DIVERGENT_ARGV));
  const displaced = displacedChangeIds(before, after);
  if (displaced.length) {
    throw new Error(
      `${options.context} displaced uncommitted work from ${options.location} into divergent change(s) ${displaced.join(", ")}. ` +
        "The work is preserved in those changes and must be reconciled before continuing.",
    );
  }
  // Ordinary jj output may include descriptions containing the word "recovery".
  // Only jj's explicit recovery-commit diagnostic is evidence of displacement.
  if (/^Created and checked out recovery commit\b/im.test(output))
    throw new Error(`${options.context} created recovery history while updating stale metadata.`);
  return { output, displacedChangeIds: displaced };
}
