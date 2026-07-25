# I00 — Documentation, repository, and toolchain alignment

**Status:** Planned  
**Depends on:** none

## Outcome

The replacement documentation becomes normative, historical docs are retired, every top-level repository area is classified as core product, client, Host infrastructure, experiment, generated output, or removal candidate, and the deterministic gate the project's premise depends on runs automatically.

## Scope

- Review and adopt `tmp/docs` into the project docs root.
- Reconcile README terminology and repository layout.
- Preserve only enduring decisions from the legacy archive.
- Stop shipping obsolete documentation in the Pi package.
- Define package/release inclusion explicitly.
- Stop tracking generated desktop bundles unless a documented packaging constraint requires them.
- Classify every crate/package/app/service against the target architecture.
- Record merge/remove decisions for proof-era Host layers.

## Toolchain and hygiene

These are independent of every cutover and can proceed concurrently with any other initiative.

### Add a formatter and linter, then reformat `concurrency/` and `jj/`

No formatter or linter is configured — no biome, eslint, prettier, oxlint, dprint, or editorconfig, and no `[lints]` section in `Cargo.toml`. Nothing pushes back on density.

| Module | Lines | Lines > 120 chars |
|---|---|---|
| `jj` | 2,990 | 425 (14%) |
| `concurrency` | 3,289 | 247 (7%) |
| `subagents` | 4,411 | 208 (4%) |
| `guardian` | 1,218 | 18 (1%) |
| `config`, `web`, `footer`, `capabilities` | ~1,600 | 8 (0.5%) |

Extremes: `concurrency/persistence.ts:226` is 702 characters; `concurrency/reviews.ts:24` is 582; `concurrency/host-state.ts:70` is 622. Whole interfaces are declared as single lines of 15 readonly fields. There are 13 comment lines in 15,401 lines of `packages/pi-tai/src`.

This is not cosmetic: density tracks with recency and complexity, which is the inverse of what is wanted. The invariants in `concurrency/` and `jj/` are the ones that cannot afford to be wrong and are currently the least reviewable code in the repository. The Rust half is idiomatic by comparison, so the inconsistency is within the TypeScript only. This is the highest-leverage item in the initiative.

### Add CI running `just check`

There is no `.github/` directory. `npm run check` already chains `protocol:check → typecheck → test → test:rust`. For a project whose premise is agent-generated changes gated by deterministic checks, having the gate and not running it automatically is a conspicuous hole.

### Test hygiene

The unit suite writes enrollment state into `~/.config/jj/repos/`. Tests must confine this to a temporary root and clean up. Symptom: the suite fails under a sandbox that blocks writes outside the project (4 failures in `subagents.test.ts` and `session-workspace.test.ts`) and passes fully outside it.

### Correct stale documentation

- `SETTINGS.md`'s Action Guardian section describes an interactive approval path that does not exist in code. See I13 D10.
- `SETTINGS.md` documents project-layer configuration without mentioning privilege, so it becomes inaccurate the moment I13 checkpoint 4 lands. Restructure it along the three-plane split of I13 D6 and remove its "Native Pi settings" section, after that checkpoint.

## Exit criteria

- All internal docs link to one indexed normative tree.
- No active document conflicts with Host-authoritative session persistence.
- Concurrency/JJ documents retain all accepted invariants and test requirements.
- Root README points to product, architecture, concurrency, and roadmap indexes.
- Package dry-run contains only intended user/contributor documentation.
- Legacy docs can be deleted without losing an active decision.
- A formatter and linter are configured and enforced; `concurrency/` and `jj/` are reformatted.
- CI runs `just check` on every change.
- The unit suite passes under a sandbox that blocks writes outside the project.
- No active document describes behavior that does not exist in code.
