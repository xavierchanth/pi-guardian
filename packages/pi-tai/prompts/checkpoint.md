---
description: Checkpoint all current work into coherent semantic changes
argument-hint: "[additional instructions]"
---
Checkpoint all of my current work now.

Load and follow the `jj-guidelines` skill. This request explicitly authorizes the mutating version-control commands needed to create and organize checkpoints; do not stop to present a command plan or ask for confirmation.

Inspect the working copy and the relevant mutable stack, including contiguous unnamed, `wip:`, or clearly temporary ancestors. Review diffs and suspicious untracked or generated files before recording anything. Validate the work when practical, using focused checks appropriate to the changed files.

Make a best-effort attempt to leave the work as a clean, reviewable semantic stack:

- Split large revisions when they contain clearly disjoint changes, preferring non-interactive file-based operations when boundaries are clear.
- Keep cohesive changes together; do not split merely because several files changed.
- Squash adjacent revisions that are artificial fragments of one change.
- Preserve dependency ordering between refactors, behavior, tests, documentation, tooling, and polish.
- Give every resulting checkpoint a concise Conventional Commit description.
- Do not include secrets, machine-local files, caches, generated build output, or other accidental artifacts.
- Do not rewrite already coherent, intentionally described history unless necessary to organize the current unfinished work.

Use Jujutsu when this is a JJ repository; otherwise use the repository's normal VCS workflow. If some changes cannot be safely classified or validated, checkpoint the coherent remainder and clearly report what was left uncheckpointed and why. Do not create empty described revisions. When using JJ, finish on a fresh empty unnamed working-copy revision after the final coherent checkpoint.

Report the checkpoints created or rewritten, validation performed, and any residual risks or uncheckpointed files.

## Additional instructions

Apply the following instructions when organizing and validating the checkpoints, without weakening the safety requirements above.

${ARGUMENTS:-No additional instructions were provided.}
